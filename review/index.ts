import { getMarkdownTheme, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Box, Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REVIEWER_SYSTEM_PROMPT = [
	"You are an isolated code reviewer.",
	"",
	"Rules:",
	"- Review ONLY based on the user prompt and provided git diff/status.",
	"- Do not assume intent from prior chat history.",
	"- You may use read-only and web/documentation tools if available.",
	"- Do not modify files.",
	"- You may run git status/git diff for verification if needed.",
	"",
	"Output format:",
	"1) Summary",
	"2) Findings (severity: high/medium/low, file, explanation, fix suggestion)",
	"3) Missing tests / validation",
	"4) Final verdict",
].join("\n");

const REVIEW_TOOL_NAME = "review_subagent";

const pendingReviews = new Map<string, { request: string; cwd: string; createdAt: number }>();

// Sweep stale entries every 2 minutes
const REVIEW_TTL_MS = 5 * 60_000;
setInterval(() => {
	const now = Date.now();
	for (const [nonce, v] of pendingReviews.entries()) {
		if (now - v.createdAt > REVIEW_TTL_MS) pendingReviews.delete(nonce);
	}
}, 2 * 60_000);

function buildReviewRequest(userPrompt: string, status: string, diff: string): string {
	const scope = userPrompt.trim()
		? `Review focus from user:\n${userPrompt.trim()}\n`
		: "Review focus: all uncommitted changes.\n";

	return [
		"Perform a code review for the following change set.",
		"",
		scope,
		"Git status (--short):",
		"```text",
		status || "(empty)",
		"```",
		"",
		"Git diff (HEAD):",
		"```diff",
		diff || "(empty)",
		"```",
		"",
		"If there are no meaningful changes, say so explicitly.",
	].join("\n");
}

function buildSubagentCommand(promptFile: string, guardExtensionPath: string): string[] {
	return [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--system-prompt",
		REVIEWER_SYSTEM_PROMPT,
		"--tools",
		"read,bash,grep,find,ls",
		"--extension",
		guardExtensionPath,
		`@${promptFile}`,
	];
}

function shorten(text: string, max = 120): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max - 3)}...`;
}

function formatToolCall(toolName: string, args: Record<string, unknown>): string {
	const str = (val: unknown) => String(val ?? "...");
	switch (toolName) {
		case "bash": return `$ ${shorten(str(args.command), 100)}`;
		case "read": return `read ${str(args.path)}`;
		case "grep": return `grep /${str(args.pattern).replace("...", "")}/ in ${str(args.path).replace("...", ".")}`;
		case "find": return `find ${str(args.pattern).replace("...", "*")} in ${str(args.path).replace("...", ".")}`;
		case "ls": return `ls ${str(args.path).replace("...", ".")}`;
		default: return `${toolName} ${shorten(JSON.stringify(args ?? {}), 80)}`;
	}
}

interface ReviewRenderDetails {
	state: "running" | "completed";
	lines: string[];
	finalOutput?: string;
	error?: string;
}

async function runReviewerProcess(
	cwd: string,
	args: string[],
	onEventLine: (line: string) => void,
	signal?: AbortSignal,
): Promise<{ code: number; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn("pi", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let stderr = "";
		let stdoutBuf = "";

		child.stdout.on("data", (buf: Buffer) => {
			stdoutBuf += buf.toString("utf8");
			const lines = stdoutBuf.split("\n");
			stdoutBuf = lines.pop() ?? "";
			for (const line of lines) onEventLine(line);
		});

		child.stderr.on("data", (buf: Buffer) => {
			stderr += buf.toString("utf8");
		});

		child.on("error", reject);
		child.on("close", (code) => {
			if (stdoutBuf.trim()) onEventLine(stdoutBuf.trim());
			resolve({ code: code ?? 1, stderr });
		});

		if (signal) {
			const abort = () => child.kill("SIGTERM");
			if (signal.aborted) abort();
			signal.addEventListener("abort", abort, { once: true });
		}
	});
}

export default function reviewExtension(pi: ExtensionAPI): void {
	pi.registerMessageRenderer("review-report", (message, _options, theme) => {
		const body = typeof message.content === "string" ? message.content : String(message.content ?? "");
		const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
		box.addChild(new Markdown(body, 0, 0, getMarkdownTheme()));
		return box;
	});

	pi.registerTool({
		name: REVIEW_TOOL_NAME,
		label: "Review Subagent",
		description: "Run an isolated reviewer subprocess. Internal tool used by /review command.",
		parameters: Type.Object({ nonce: Type.String() }),

		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			const entry = pendingReviews.get(params.nonce);
			if (!entry) {
				return {
					isError: true,
					content: [{ type: "text", text: "Unauthorized review invocation (missing/expired nonce). Use /review." }],
				};
			}
			pendingReviews.delete(params.nonce);

			const lines: string[] = ["Reviewing..."];
			let finalOutput = "";
			let error = "";

			const emit = (state: "running" | "completed") => {
				onUpdate?.({
					content: [{ type: "text", text: finalOutput || "Reviewing..." }],
					details: { state, lines: [...lines], finalOutput, error } satisfies ReviewRenderDetails,
				});
			};

			const tmpBase = await mkdtemp(join(tmpdir(), "pi-review-"));
			const promptFile = join(tmpBase, "review-prompt.md");
			await writeFile(promptFile, entry.request, "utf8");

			const thisDir = dirname(fileURLToPath(import.meta.url));
			const guardExtensionPath = join(thisDir, "review-readonly-guard.ts");
			const subagentArgs = buildSubagentCommand(promptFile, guardExtensionPath);

			try {
				emit("running");
				const res = await runReviewerProcess(
					entry.cwd,
					subagentArgs,
					(line) => {
						const trimmed = line.trim();
						if (!trimmed) return;
						try {
							const event = JSON.parse(trimmed) as {
								type?: string;
								toolName?: string;
								args?: Record<string, unknown>;
								isError?: boolean;
								message?: {
									role?: string;
									stopReason?: string;
									errorMessage?: string;
									content?: Array<{ type?: string; text?: string }>;
								};
							};

							if (event.type === "tool_execution_start") {
								lines.push(`→ ${formatToolCall(event.toolName ?? "tool", event.args ?? {})}`);
								emit("running");
								return;
							}
							if (event.type === "tool_execution_end") {
								const symbol = event.isError ? "✗" : "✓";
								lines.push(`${symbol} ${event.toolName ?? "tool"}`);
								emit("running");
								return;
							}
							if (event.type === "message_end" && event.message?.role === "assistant") {
								const textParts = (event.message.content ?? [])
									.filter((p) => p.type === "text" && typeof p.text === "string")
									.map((p) => p.text as string);
								if (textParts.length > 0) {
									finalOutput = textParts.join("\n").trim();
									lines.push(shorten(finalOutput.replace(/\s+/g, " "), 140));
								}
								if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
									error = event.message.errorMessage || `Reviewer ${event.message.stopReason}`;
								}
								emit("running");
							}
						} catch {
							// ignore non-JSON lines
						}
					},
					signal,
				);

				if (res.code !== 0) {
					error = (res.stderr || "").trim() || error || `Reviewer failed with exit ${res.code}`;
					emit("completed");
					return {
						isError: true,
						content: [{ type: "text", text: error }],
						details: {
							state: "completed",
							lines,
							finalOutput: finalOutput || "",
							error,
						} satisfies ReviewRenderDetails,
					};
				}

				const report = finalOutput || "Reviewer returned no output.";
				emit("completed");
				pi.sendMessage({
					customType: "review-report",
					display: true,
					content: report,
					details: { isolated: true, ok: true },
				});
				return {
					content: [{ type: "text", text: report }],
					details: {
						state: "completed",
						lines,
						finalOutput: report,
					} satisfies ReviewRenderDetails,
				};
			} finally {
				await rm(tmpBase, { recursive: true, force: true });
			}
		},

		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("review_subagent ")) + theme.fg("muted", `nonce=${String(args.nonce ?? "")}`),
				0,
				0,
			);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as ReviewRenderDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const lines = details.lines ?? [];
			const finalOutput = details.finalOutput ?? "";

			if (!isPartial) {
				return new Text(theme.fg("muted", "Review complete. Final report shown below."), 0, 0);
			}

			if (!expanded) {
				return new Text([
					theme.fg("warning", "⏳ Reviewing... (Ctrl+O expand)"), 
					...lines.slice(-10).map(l => theme.fg("toolOutput", l))
				].join("\n"), 0, 0);
			}

			const container = new Container();
			container.addChild(new Text(theme.fg("warning", "⏳ Reviewing..."), 0, 0));
			if (lines.length > 0) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(lines.map((l) => theme.fg("toolOutput", l)).join("\n"), 0, 0));
			}
			if (finalOutput) {
				container.addChild(new Spacer(1));
				container.addChild(new Markdown(finalOutput, 0, 0, getMarkdownTheme()));
			}
			if (details.error) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("error", details.error), 0, 0));
			}
			return container;
		},
	});

	pi.registerCommand("review", {
		description: "Run isolated review of uncommitted changes or a custom review scope",
		handler: async (args, ctx) => {
			const statusRes = await pi.exec("git", ["status", "--short"], {
				cwd: ctx.cwd,
				timeout: 20_000,
				signal: ctx.signal,
			});
			const diffRes = await pi.exec("git", ["diff", "--no-color", "HEAD"], {
				cwd: ctx.cwd,
				timeout: 60_000,
				signal: ctx.signal,
			});
			const status = statusRes.stdout.trim();
			const diff = diffRes.stdout;

			if (!diff.trim()) {
				if (!status) {
					ctx.ui.notify("No uncommitted changes to review.", "info");
					return;
				}
				ctx.ui.notify("No diff output. Untracked files are not reviewable until added (git add).", "warning");
				return;
			}

			const request = buildReviewRequest(args ?? "", status, diff);
			const nonce = randomBytes(12).toString("hex");
			pendingReviews.set(nonce, { request, cwd: ctx.cwd, createdAt: Date.now() });

			pi.sendUserMessage(
				`Run a code review now by calling tool ${REVIEW_TOOL_NAME} with JSON arguments {"nonce":"${nonce}"}.\n` +
					"Do not call any other tools before this. After the tool returns, provide one short confirmation sentence.",
			);
		},
	});
}
