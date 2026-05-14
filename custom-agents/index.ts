import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text, type AutocompleteItem } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { loadAgentProfiles, type AgentProfile } from "./utils.js";

const AGENTS_DIR = join(homedir(), ".pi", "agent", "agents");
const DEFAULT_TOOLS = ["read", "bash", "edit", "write"];

type PersistedState = { activeAgentName?: string };

function buildToolsForAgent(pi: ExtensionAPI, agent: AgentProfile): string[] {
	if (!agent.allowedTools || agent.allowedTools.length === 0) return pi.getActiveTools();
	const all = new Set(pi.getAllTools().map((t) => t.name));
	return agent.allowedTools.filter((t) => all.has(t));
}

function selectDefaultAgent(profiles: AgentProfile[]): AgentProfile | undefined {
	return profiles.find((p) => p.type === "primary") ?? profiles[0];
}

function parseSubagentText(stdout: string): string {
	let lastAssistantText = "";
	for (const line of stdout.split("\n")) {
		if (!line.trim()) continue;
		try {
			const event = JSON.parse(line) as { type?: string; message?: any };
			if (event.type === "message_end" && event.message?.role === "assistant") {
				const content = event.message.content;
				if (typeof content === "string") {
					lastAssistantText = content;
				} else if (Array.isArray(content)) {
					const textPart = content.find((c: any) => c.type === "text");
					if (textPart?.text) lastAssistantText = textPart.text;
				}
			}
		} catch {
			// ignore malformed JSONL
		}
	}
	return lastAssistantText.trim();
}

async function runSubagent(
	cwd: string,
	agent: AgentProfile,
	prompt: string,
	signal?: AbortSignal,
): Promise<{ text: string; stderr: string; code: number | null }> {
	const tmpDir = await mkdtemp(join(tmpdir(), "pi-agent-extension-"));
	const systemPath = join(tmpDir, "system.md");
	await writeFile(systemPath, agent.systemPromptTemplate, "utf8");

	const args = ["--mode", "json", "--no-session", "--append-system-prompt", systemPath, "-p"];
	if (agent.allowedTools && agent.allowedTools.length > 0) {
		args.push("--tools", agent.allowedTools.join(","));
	}
	args.push(prompt);

	const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
		const proc = spawn("pi", args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (d) => (stdout += String(d)));
		proc.stderr.on("data", (d) => (stderr += String(d)));
		proc.on("close", (code) => resolve({ stdout, stderr, code }));
		proc.on("error", (err) => resolve({ stdout, stderr: `${stderr}\n${(err as Error).message}`, code: 1 }));
		if (signal) {
			const abort = () => proc.kill("SIGTERM");
			if (signal.aborted) abort();
			else signal.addEventListener("abort", abort, { once: true });
		}
	});

	await rm(tmpDir, { recursive: true, force: true });
	return { text: parseSubagentText(result.stdout), stderr: result.stderr, code: result.code };
}

export default function agentExtension(pi: ExtensionAPI): void {
	let profiles: AgentProfile[] = [];
	let activeAgentName: string | undefined;
	let previousTools: string[] | null = null;

	function getActiveProfile(): AgentProfile | undefined {
		if (!activeAgentName) return undefined;
		return profiles.find((p) => p.name === activeAgentName);
	}

	function setActiveAgent(nameOrId: string, notify = true, ctx?: any): boolean {
		const profile = profiles.find((p) => (p.name === nameOrId || p.id === nameOrId) && p.type === "primary");
		if (!profile) return false;
		activeAgentName = profile.name;
		pi.appendEntry("agent-extension", { activeAgentName } satisfies PersistedState);
		if (notify && ctx?.ui) ctx.ui.notify(`Active agent: ${profile.name}`, "info");
		return true;
	}

	function cyclePrimary(ctx: any): void {
		const primaries = profiles.filter((p) => p.type === "primary");
		if (primaries.length === 0) {
			ctx.ui.notify("No primary agents found in ~/.pi/agent/agents", "warning");
			return;
		}
		const idx = Math.max(0, primaries.findIndex((p) => p.name === activeAgentName));
		const next = primaries[(idx + 1) % primaries.length];
		setActiveAgent(next.name, true, ctx);
	}

	function refreshStatus(ctx: any): void {
		const active = getActiveProfile();
		ctx.ui.setStatus("agent-profile", active ? `🤖 ${active.name}` : undefined);
	}

	pi.registerCommand("agent", {
		description: "Manage agent profiles from ~/.pi/agent/agents",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const items: AutocompleteItem[] = [];
			for (const profile of profiles) {
				if (profile.id.startsWith(prefix)) {
					items.push({ value: profile.id, label: `${profile.id} [${profile.type}]` });
				} else if (profile.name.startsWith(prefix)) {
					items.push({ value: profile.name, label: `${profile.name} [${profile.type}]` });
				}
			}
			const builtins = ["list", "next"];
			for (const b of builtins) {
				if (b.startsWith(prefix)) items.push({ value: b, label: b });
			}
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const command = (args ?? "").trim();
			if (command === "" || command === "list") {
				const lines = profiles.map((p) => `${p.id} / ${p.name} [${p.type}]${p.allowedTools ? ` tools=${p.allowedTools.join(",")}` : ""}`);
				ctx.ui.notify(lines.length ? lines.join("\n") : "No agent profiles found", "info");
				return;
			}
			if (command === "next") {
				cyclePrimary(ctx);
				refreshStatus(ctx);
				return;
			}
			if (setActiveAgent(command, true, ctx)) {
				refreshStatus(ctx);
				return;
			}
			ctx.ui.notify(`Unknown primary agent: ${command}`, "error");
		},
	});

	pi.registerShortcut("alt+p", {
		description: "Switch to next primary agent",
		handler: async (ctx) => {
			cyclePrimary(ctx);
			refreshStatus(ctx);
		},
	});

	pi.registerTool({
		name: "run_subagent",
		description: "Run a subagent with isolated context. Input prompt is sent without main-agent history.",
		promptGuidelines: [
			"Use this tool when you need focused delegated work with isolated context.",
			"Only use agents whose type is subagent.",
		],
		parameters: Type.Object({
			agent_name: Type.String({ description: "Subagent name or id from ~/.pi/agent/agents/*.md" }),
			prompt: Type.String({ description: "Prompt for the subagent (no parent context is included)" }),
		}),
		renderCall: (args, theme) => {
			return new Text(theme.fg("toolTitle", theme.bold(`run_subagent ${args.agent_name}`)), 0, 0);
		},
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const sub = profiles.find((p) => (p.name === params.agent_name || p.id === params.agent_name) && p.type === "subagent");
			if (!sub) {
				const available = profiles.filter((p) => p.type === "subagent").map((p) => `${p.id} / ${p.name}`).join(", ") || "none";
				return {
					content: [{ type: "text" as const, text: `Unknown subagent '${params.agent_name}'. Available: ${available}` }],
					isError: true,
				};
			}

			const result = await runSubagent(ctx.cwd, sub, params.prompt, signal);
			if ((result.code ?? 1) !== 0) {
				return {
					content: [{ type: "text" as const, text: `Subagent failed: ${result.stderr || "unknown error"}` }],
					isError: true,
				};
			}

			return {
				content: [{ type: "text" as const, text: result.text || "(no output)" }],
				details: { agent: sub.name, type: sub.type, source: sub.sourcePath },
			};
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const loaded = await loadAgentProfiles(AGENTS_DIR);
		profiles = loaded.profiles;
		for (const error of loaded.errors) ctx.ui.notify(`[agent-extension] ${error}`, "warning");

		const entries = ctx.sessionManager.getEntries();
		const state = entries
			.filter((e: any) => e.type === "custom" && e.customType === "agent-extension")
			.pop() as { data?: PersistedState } | undefined;
		activeAgentName = state?.data?.activeAgentName;

		if (!getActiveProfile()) {
			const fallback = selectDefaultAgent(profiles);
			activeAgentName = fallback?.name;
		}

		refreshStatus(ctx);
	});

	pi.on("before_agent_start", async (event) => {
		const active = getActiveProfile();
		if (!active) return;

		if (active.allowedTools && active.allowedTools.length > 0) {
			if (!previousTools) previousTools = pi.getActiveTools();
			pi.setActiveTools(buildToolsForAgent(pi, active));
		} else if (previousTools) {
			pi.setActiveTools(previousTools);
			previousTools = null;
		}

		return {
			systemPrompt:
				event.systemPrompt +
				`\n\n[AGENT PROFILE ACTIVE]\nname: ${active.name}\ntype: ${active.type}\n\n${active.systemPromptTemplate}`,
		};
	});

	pi.on("agent_end", async () => {
		if (previousTools) {
			pi.setActiveTools(previousTools);
			previousTools = null;
		} else {
			const active = getActiveProfile();
			if (!active?.allowedTools) {
				const current = pi.getActiveTools();
				if (current.length === 0) pi.setActiveTools(DEFAULT_TOOLS);
			}
		}
	});
}
