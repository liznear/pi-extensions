/**
 * Plan Mode Extension
 *
 * A focused planning mode that restricts file modifications to .pi/plans/ folder.
 * Plans are stored as markdown files with naming convention: <yyyy-mm-dd>-<feature-name>.md
 *
 * Features:
 * - /plan command or Alt+P to toggle
 * - Custom edit_plan tool for creating/updating plan files
 * - Bash restricted to read-only commands
 * - Plans stored in .pi/plans/ directory
 * - Date-prefixed file naming
 */

import type { TextContent } from "@mariozechner/pi-ai";
import type { AgentMessage, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { withFileMutationQueue } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { isSafeCommand } from "./utils.js";

// Tools available in plan mode (edit_plan replaces write/edit)
const PLAN_MODE_TOOLS = ["read", "bash", "edit_plan", "grep", "find", "ls"];
const NORMAL_MODE_TOOLS = ["read", "bash", "edit", "write"];

// Plan directory relative to project root
const PLANS_DIR = ".pi/plans";

const PLAN_FILENAME_PATTERN = /^\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.md$/;

function getPlanDisplayName(args: { filename?: string; feature_name?: string; action: string }): string {
	if (args.filename) return args.filename;
	if (args.feature_name) return args.feature_name;
	return args.action;
}

function validatePlanFilename(filename: string): { ok: true } | { ok: false; error: string } {
	if (!filename?.trim() || filename.trim() !== filename) return { ok: false, error: "Filename must be non-empty without surrounding spaces." };
	if (/[/\\]/.test(filename)) return { ok: false, error: "Filename must not contain path separators." };
	if (!PLAN_FILENAME_PATTERN.test(filename)) return { ok: false, error: "Filename must match <yyyy-mm-dd>-<feature-name>.md using lowercase letters, numbers, and hyphens." };
	return { ok: true };
}

function resolvePlanFilePath(plansPath: string, filename: string): { ok: true; filePath: string } | { ok: false; error: string } {
	const validation = validatePlanFilename(filename);
	if (!validation.ok) return validation;
	if (isAbsolute(filename)) return { ok: false, error: "Absolute paths are not allowed." };

	const filePath = resolve(plansPath, filename);
	const rel = relative(plansPath, filePath);
	if (rel.startsWith("..") || isAbsolute(rel)) return { ok: false, error: "Resolved plan path escapes plans directory." };

	return { ok: true, filePath };
}

// Generate plan filename with date prefix
function generatePlanFilename(featureName: string): string {
	const date = new Date().toISOString().split("T")[0]; // yyyy-mm-dd
	const sanitized = featureName
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 50);
	return `${date}-${sanitized}.md`;
}

// Ensure plans directory exists
async function ensurePlansDir(cwd: string): Promise<string> {
	const plansPath = resolve(cwd, PLANS_DIR);
	await mkdir(plansPath, { recursive: true });
	return plansPath;
}

// List existing plan files
async function listPlans(cwd: string): Promise<string[]> {
	try {
		const plansPath = resolve(cwd, PLANS_DIR);
		const files = await readdir(plansPath);
		return files.filter((f) => f.endsWith(".md")).sort().reverse();
	} catch {
		return [];
	}
}

export default function planModeExtension(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	let previousActiveTools: string[] | null = null;

	// Register CLI flag
	pi.registerFlag("plan", {
		description: "Start in plan mode (restricted to .pi/plans/ edits)",
		type: "boolean",
		default: false,
	});

	// Register the custom edit_plan tool
	pi.registerTool({
		name: "edit_plan",
		label: "Edit Plan",
		description: `Create or update a plan file in .pi/plans/ directory. Plans are markdown files named with date prefix: <yyyy-mm-dd>-<feature-name>.md. Use this to document implementation plans, architecture decisions, or task breakdowns.`,
		promptSnippet: "Create or update plan files in .pi/plans/",
		promptGuidelines: [
			"Use edit_plan to create structured plans before implementing changes.",
			"Plan files are stored in .pi/plans/ with date-prefixed names.",
			"Use action 'list' to see existing plans, 'create' for new plans, 'update' to modify existing plans.",
		],
		parameters: Type.Object({
			action: StringEnum(["list", "create", "update", "read"] as const, {
				description: "Action to perform: list plans, create new plan, update existing plan, or read a plan",
			}),
			feature_name: Type.Optional(
				Type.String({
					description: "Feature name for the plan (used in filename). Required for 'create' action.",
				}),
			),
			filename: Type.Optional(
				Type.String({
					description: "Exact filename for 'update' or 'read' action (e.g., '2024-01-15-add-auth.md')",
				}),
			),
			content: Type.Optional(
				Type.String({
					description: "Markdown content for the plan. Required for 'create' and 'update' actions.",
				}),
			),
			append: Type.Optional(
				Type.Boolean({
					description: "If true, append content to existing plan instead of replacing. Default: false",
				}),
			),
		}),
		renderCall: (args, theme, context) => {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			if (!context.expanded) {
				text.setText(theme.fg("toolTitle", theme.bold(`Edit plan: ${getPlanDisplayName(args)}`)));
				return text;
			}

			text.setText(theme.fg("toolTitle", theme.bold("edit_plan ")) + theme.fg("muted", args.action));
			return text;
		},
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const plansPath = await ensurePlansDir(ctx.cwd);

			switch (params.action) {
				case "list": {
					const plans = await listPlans(ctx.cwd);
					if (plans.length === 0) {
						return {
							content: [
								{
									type: "text" as const,
									text: `No plan files found in ${PLANS_DIR}/\n\nUse edit_plan with action 'create' to create a new plan.`,
								},
							],
							details: { plans: [], plansPath },
						};
					}
					const list = plans.map((p) => `- ${p}`).join("\n");
					return {
						content: [
							{
								type: "text" as const,
								text: `Plan files in ${PLANS_DIR}/:\n\n${list}\n\nUse action 'read' with filename to view a plan.`,
							},
						],
						details: { plans, plansPath },
					};
				}

				case "read": {
					if (!params.filename) {
						return {
							content: [
								{
									type: "text" as const,
									text: "Error: 'filename' parameter is required for 'read' action.",
								},
							],
							isError: true,
						};
					}
					const resolved = resolvePlanFilePath(plansPath, params.filename);
					if (!resolved.ok) {
						return {
							content: [{ type: "text" as const, text: `Error: Invalid filename. ${resolved.error}` }],
							isError: true,
						};
					}
					try {
						const content = await readFile(resolved.filePath, "utf8");
						return {
							content: [{ type: "text" as const, text: content }],
							details: { filename: params.filename, plansPath },
						};
					} catch {
						return {
							content: [
								{
									type: "text" as const,
									text: `Error: Plan file '${params.filename}' not found. Use action 'list' to see available plans.`,
								},
							],
							isError: true,
						};
					}
				}

				case "create": {
					if (!params.feature_name) {
						return {
							content: [
								{
									type: "text" as const,
									text: "Error: 'feature_name' parameter is required for 'create' action.",
								},
							],
							isError: true,
						};
					}
					if (!params.content) {
						return {
							content: [
								{
									type: "text" as const,
									text: "Error: 'content' parameter is required for 'create' action.",
								},
							],
							isError: true,
						};
					}

					const filename = generatePlanFilename(params.feature_name);
					const filePath = resolve(plansPath, filename);

					return withFileMutationQueue(filePath, async () => {
						// Add header if content doesn't start with one
						let content = params.content!;
						if (!content.startsWith("# ")) {
							const title = params.feature_name!.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
							content = `# ${title}\n\n${content}`;
						}

						await writeFile(filePath, content, "utf8");
						return {
							content: [
								{
									type: "text" as const,
									text: `Created plan: ${PLANS_DIR}/${filename}\n\nPath: ${filePath}`,
								},
							],
							details: { filename, plansPath, action: "create" },
						};
					});
				}

				case "update": {
					if (!params.filename) {
						return {
							content: [
								{
									type: "text" as const,
									text: "Error: 'filename' parameter is required for 'update' action.",
								},
							],
							isError: true,
						};
					}
					if (!params.content) {
						return {
							content: [
								{
									type: "text" as const,
									text: "Error: 'content' parameter is required for 'update' action.",
								},
							],
							isError: true,
						};
					}

					const resolved = resolvePlanFilePath(plansPath, params.filename);
					if (!resolved.ok) {
						return {
							content: [{ type: "text" as const, text: `Error: Invalid filename. ${resolved.error}` }],
							isError: true,
						};
					}

					return withFileMutationQueue(resolved.filePath, async () => {
						try {
							const existing = await readFile(resolved.filePath, "utf8");
							const newContent = params.append
								? `${existing}\n\n---\n\n${params.content}`
								: params.content!;

							await writeFile(resolved.filePath, newContent, "utf8");
							return {
								content: [
									{
										type: "text" as const,
										text: `Updated plan: ${PLANS_DIR}/${params.filename}`,
									},
								],
								details: { filename: params.filename, plansPath, action: "update", appended: params.append ?? false },
							};
						} catch {
							return {
								content: [
									{
										type: "text" as const,
										text: `Error: Plan file '${params.filename}' not found. Use action 'list' to see available plans or 'create' to create a new plan.`,
									},
								],
								isError: true,
							};
						}
					});
				}
			}
		},
	});

	function updateStatus(ctx: ExtensionContext): void {
		if (planModeEnabled) {
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("accent", "📋 Plan Mode"));
		} else {
			ctx.ui.setStatus("plan-mode", undefined);
		}
	}

	function togglePlanMode(ctx: ExtensionContext): void {
		planModeEnabled = !planModeEnabled;

		if (planModeEnabled) {
			previousActiveTools = pi.getActiveTools();
			pi.setActiveTools(PLAN_MODE_TOOLS);
			ctx.ui.notify(`Plan mode enabled. Edits restricted to ${PLANS_DIR}/`, "info");
		} else {
			const toolsToRestore = previousActiveTools?.length ? previousActiveTools : NORMAL_MODE_TOOLS;
			pi.setActiveTools(toolsToRestore);
			previousActiveTools = null;
			ctx.ui.notify("Plan mode OFF", "info");
		}
		updateStatus(ctx);
	}

	function persistState(): void {
		pi.appendEntry("plan-mode", { enabled: planModeEnabled });
	}

	// Register commands
	pi.registerCommand("plan", {
		description: "Toggle plan mode (restricted to .pi/plans/ edits)",
		handler: async (_args, ctx) => togglePlanMode(ctx),
	});

	pi.registerCommand("plans", {
		description: "List all plan files in .pi/plans/",
		handler: async (_args, ctx) => {
			const plans = await listPlans(ctx.cwd);
			if (plans.length === 0) {
				ctx.ui.notify(`No plans found in ${PLANS_DIR}/`, "info");
				return;
			}
			const list = plans.map((p) => `  ${p}`).join("\n");
			ctx.ui.notify(`Plans in ${PLANS_DIR}/:\n${list}`, "info");
		},
	});

	// Register keyboard shortcut
	pi.registerShortcut("alt+p", {
		description: "Toggle plan mode",
		handler: async (ctx) => togglePlanMode(ctx),
	});

	// Block destructive bash commands in plan mode
	pi.on("tool_call", async (event) => {
		if (!planModeEnabled || event.toolName !== "bash") return;

		const command = event.input.command as string;
		if (!isSafeCommand(command)) {
			return {
				block: true,
				reason: `Plan mode: command blocked (not in allowlist). Use /plan to disable plan mode first.\nCommand: ${command}`,
			};
		}
	});

	// Filter out stale plan mode context when not in plan mode
	pi.on("context", async (event) => {
		if (planModeEnabled) return;

		return {
			messages: event.messages.filter((m) => {
				const msg = m as AgentMessage & { customType?: string };
				if (msg.customType === "plan-mode-context") return false;
				if (msg.role !== "user") return true;

				const content = msg.content;
				if (typeof content === "string") {
					return !content.includes("[PLAN MODE ACTIVE]");
				}
				if (Array.isArray(content)) {
					return !content.some(
						(c) => c.type === "text" && (c as TextContent).text?.includes("[PLAN MODE ACTIVE]"),
					);
				}
				return true;
			}),
		};
	});

	// Inject plan mode context before agent starts
	pi.on("before_agent_start", async () => {
		if (!planModeEnabled) return;

		return {
			message: {
				customType: "plan-mode-context",
				content: `[PLAN MODE ACTIVE]
You are in plan mode - a focused planning mode for creating implementation plans.

Restrictions:
- You can only use: read, bash, grep, find, ls, edit_plan
- You CANNOT use: edit, write (file modifications are disabled except for plan files)
- Bash is restricted to read-only commands
- The edit_plan tool only works with files in ${PLANS_DIR}/

Your task is to:
1. Explore the codebase using read-only tools
2. Create detailed implementation plans using the edit_plan tool
3. Document architecture decisions and task breakdowns

Plan file naming:
- Files are automatically named with date prefix: <yyyy-mm-dd>-<feature-name>.md
- Use descriptive feature names (e.g., "add-user-auth", "refactor-database-layer")

Use edit_plan with action 'create' to create a new plan, providing a feature_name and markdown content.`,
				display: false,
			},
		};
	});

	// Restore state on session start
	pi.on("session_start", async (_event, ctx) => {
		if (pi.getFlag("plan") === true) {
			planModeEnabled = true;
		}

		const entries = ctx.sessionManager.getEntries();
		const planModeEntry = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "plan-mode")
			.pop() as { data?: { enabled: boolean } } | undefined;

		if (planModeEntry?.data) {
			planModeEnabled = planModeEntry.data.enabled ?? planModeEnabled;
		}

		if (planModeEnabled) {
			previousActiveTools = pi.getActiveTools();
			pi.setActiveTools(PLAN_MODE_TOOLS);
		}
		updateStatus(ctx);
	});

	// Persist state on changes
	pi.on("agent_end", async () => {
		persistState();
	});
}
