/**
 * Mini-Task Extension - Agentic context management via task-scoped compression
 *
 * Breaks work into explicit mini-tasks. When a mini-task completes, the entire
 * conversation range is compressed into a summary via tree branching, freeing
 * context window space.
 *
 * Tools (LLM-facing):
 *   mini_task_start     - Start a tracked mini-task with a save point
 *   mini_task_handoff   - Complete task, compress context, inject summary
 *   mini_task_tree      - Show task tree with status and nesting
 *
 * Command (user-facing):
 *   /mini-task          - Enable mini-task management, show dashboard
 *
 * Requires: User must run /mini-task once per session to enable tree navigation.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { join, dirname } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MiniTaskData {
	id: string;
	title: string;
	description: string;
	parentId: string | null;
	/** The tag created in the session tree to mark the start of this task */
	startTag: string;
	/** The session entry ID corresponding to the start of this task */
	startEntryId: string;
	status: "active" | "completed";
}

interface PendingHandoff {
	newLeafId: string;
	id: string;
	parentId: string | null;
	nextStep: string;
	summary: string;
	filesChanged: string[];
	decisions: string[];
}

// Minimal interface for the command context we need
interface ExtensionCommandContextLike {
	navigateTree(
		targetId: string,
		options: { summarize: boolean },
	): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let taskStack: MiniTaskData[] = [];
/** Map of all tasks in the current branch history, keyed by task `id` */
let allTasksOnBranch: Map<string, MiniTaskData> = new Map();
let commandCtx: ExtensionCommandContextLike | null = null;
let pendingHandoff: PendingHandoff | null = null;
let isEnabled = true;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugify(text: string): string {
	return text
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9\s-]/g, "")
		.replace(/[\s]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 48);
}

function uniqueSlug(base: string, existing: Map<string, unknown>): string {
	let slug = slugify(base) || "task";
	if (!existing.has(slug)) return slug;
	let i = 2;
	while (existing.has(`${slug}-${i}`)) i++;
	return `${slug}-${i}`;
}

function getCurrentTask(): MiniTaskData | undefined {
	return taskStack.length > 0 ? taskStack[taskStack.length - 1] : undefined;
}

/** Reconstruct task state from the current branch's custom entries. */
function reconstructState(ctx: ExtensionContext) {
	taskStack = [];
	allTasksOnBranch = new Map();

	const branch = ctx.sessionManager.getBranch();
	for (const entry of branch) {
		if (entry.type !== "custom") continue;

		if (entry.customType === "mini-task-start") {
			const data = entry.data as MiniTaskData | undefined;
			if (data) allTasksOnBranch.set(data.id, { ...data, status: "active", startEntryId: entry.id });
		}

		if (entry.customType === "mini-task-complete") {
			const data = entry.data as { id: string } | undefined;
			if (data) {
				const task = allTasksOnBranch.get(data.id);
				if (task) task.status = "completed";
			}
		}
	}

	// Rebuild active stack in chronological order (Map iteration order matches insertion order)
	taskStack = [...allTasksOnBranch.values()].filter((t) => t.status === "active");
}

/** Build a task tree string for display. */
function renderTaskTree(
	tasks: Map<string, MiniTaskData>,
	theme: { fg: (color: string, text: string) => string },
): string[] {
	const lines: string[] = [];
	const roots = [...tasks.values()].filter((t) => !t.parentId);

	function render(task: MiniTaskData, depth: number) {
		const indent = "  ".repeat(depth);
		const icon =
			task.status === "completed"
				? theme.fg("success", "✓")
				: theme.fg("accent", "●");
		const title =
			task.status === "completed"
				? theme.fg("dim", task.title)
				: theme.fg("text", task.title);
		const id = theme.fg("muted", task.id);

		lines.push(`${indent}${icon} ${id} ${title}`);

		const children = [...tasks.values()].filter(
			(t) => t.parentId === task.id,
		);
		for (const child of children) render(child, depth + 1);
	}

	for (const root of roots) render(root, 0);
	return lines;
}

/** Update the active-task widget above the editor. */
function updateWidget(ctx: ExtensionContext) {
	if (taskStack.length === 0) {
		ctx.ui.setWidget("mini-task", undefined);
		return;
	}
	const current = getCurrentTask()!;
	const depth = taskStack.length;
	const lines = [
		ctx.ui.theme.fg(
			"accent",
			`\u25cf Task [${depth}]: ${current.id}`,
		) +
			" " +
			ctx.ui.theme.fg("muted", current.title),
	];
	if (depth > 1) {
		const parents = taskStack
			.slice(0, -1)
			.map((t) => t.id)
			.join(" \u2192 ");
		lines.push(
			ctx.ui.theme.fg("dim", `  Stack: ${parents}`),
		);
	}
	ctx.ui.setWidget("mini-task", lines);
}

// ---------------------------------------------------------------------------
// TUI Component: Task Dashboard
// ---------------------------------------------------------------------------

class TaskDashboardComponent {
	private tasks: Map<string, MiniTaskData>;
	private stack: MiniTaskData[];
	private theme: any;
	private onClose: () => void;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		tasks: Map<string, MiniTaskData>,
		stack: MiniTaskData[],
		theme: any,
		onClose: () => void,
	) {
		this.tasks = tasks;
		this.stack = stack;
		this.theme = theme;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onClose();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const th = this.theme;
		const lines: string[] = [];

		lines.push("");
		const title = th.fg("accent", " Mini-Task Dashboard ");
		const header =
			th.fg("borderMuted", "\u2500".repeat(3)) +
			title +
			th.fg("borderMuted", "\u2500".repeat(Math.max(0, width - 24)));
		lines.push(truncateToWidth(header, width));
		lines.push("");

		if (this.tasks.size === 0) {
			lines.push(
				truncateToWidth(
					`  ${th.fg("dim", "No mini-tasks yet. The LLM will create them as needed.")}`,
					width,
				),
			);
		} else {
			const treeLines = renderTaskTree(this.tasks, th);
			for (const line of treeLines) {
				lines.push(truncateToWidth(`  ${line}`, width));
			}
		}

		lines.push("");

		if (this.stack.length > 0) {
			lines.push(
				truncateToWidth(`  ${th.fg("muted", "Active stack:")}`, width),
			);
			for (let i = this.stack.length - 1; i >= 0; i--) {
				const t = this.stack[i];
				const depth = this.stack.length - 1 - i;
				const indent = "    ".repeat(depth);
				const arrow = depth === 0 ? th.fg("accent", "\u2192") : th.fg("dim", "\u21b3");
				lines.push(
					truncateToWidth(
						`  ${indent}${arrow} ${th.fg("muted", t.id)}: ${th.fg("text", t.title)}`,
						width,
					),
				);
			}
		} else {
			lines.push(
				truncateToWidth(
					`  ${th.fg("dim", "No active tasks.")}`,
					width,
				),
			);
		}

		lines.push("");
		lines.push(
			truncateToWidth(
				`  ${th.fg("dim", "Press Escape to close")}`,
				width,
			),
		);
		lines.push("");

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

// ---------------------------------------------------------------------------
// Tool parameter schemas
// ---------------------------------------------------------------------------

const StartParams = Type.Object({
	title: Type.String({
		description: "Short, descriptive title for this mini-task",
	}),
	description: Type.Optional(
		Type.String({
			description:
				"What this task aims to accomplish. Be specific about the expected outcome.",
		}),
	),
});

const HandoffParams = Type.Object({
	summary: Type.String({
		description:
			"Concise summary of what was accomplished. Include specific outcomes, not just 'done'.",
	}),
	files_changed: Type.Optional(
		Type.Array(Type.String(), {
			description: "List of files modified during this task",
		}),
	),
	decisions: Type.Optional(
		Type.Array(Type.String(), {
			description: "Key decisions made and their rationale",
		}),
	),
	findings: Type.Optional(
		Type.String({
			description:
				"For experiments: key findings, data, or conclusions discovered",
		}),
	),
	next_step: Type.String({
		description:
			"What should happen immediately after this handoff. Be specific about the action.",
	}),
});

const TreeParams = Type.Object({});

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// Discover companion skill
	const extDir =
		typeof __dirname !== "undefined"
			? __dirname
			: dirname(new URL(import.meta.url).pathname);

	pi.on("resources_discover", async () => ({
		skillPaths: [join(extDir, "skills")],
	}));

	// Reconstruct state on session events
	pi.on("session_start", async (_event, ctx) => {
		commandCtx = null;
		pendingHandoff = null;
		reconstructState(ctx);
		updateWidget(ctx);
	});
	pi.on("session_tree", async (_event, ctx) => {
		reconstructState(ctx);
		updateWidget(ctx);
	});

	// -----------------------------------------------------------------------
	// /mini-task command
	// -----------------------------------------------------------------------

	pi.registerCommand("mini-task", {
		description: "Toggle mini-task management (on/off)",
		handler: async (args, ctx) => {
			// Capture command context for tree navigation
			commandCtx = ctx as unknown as ExtensionCommandContextLike;

			const arg = args.trim().toLowerCase();
			if (arg === "off") {
				isEnabled = false;
				ctx.ui.notify("Mini-task management disabled", "info");
				return;
			} else if (arg === "on") {
				isEnabled = true;
				ctx.ui.notify("Mini-task management enabled", "info");
				return;
			} else if (arg === "continue") {
				// Just capture commandCtx
				isEnabled = true;
				ctx.ui.notify("Navigation permissions granted. The LLM will now retry.", "success");
				return;
			}

			isEnabled = true; // implicitly enable if they just run /mini-task
			if (!ctx.hasUI) {
				ctx.ui.notify("mini-task requires interactive mode", "error");
				return;
			}

			// Show interactive dashboard
			await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
				return new TaskDashboardComponent(
					allTasksOnBranch,
					taskStack,
					theme,
					() => done(),
				);
			});
		},
	});

	// -----------------------------------------------------------------------
	// mini_task_start tool
	// -----------------------------------------------------------------------

	pi.registerTool({
		name: "mini_task_start",
		label: "Mini Task Start",
		description:
			"Start a new tracked mini-task. Creates a save point in the conversation tree. " +
			"Use before any focused work to explicitly state your plan and what you are going to do. " +
			"When the task completes, call mini_task_handoff to compress the work into a summary and free context.",
		promptSnippet: "Explicitly state your plan and start a tracked mini-task",
		promptGuidelines: [
			"Use mini_task_start before any focused piece of work. It acts as a reminder for you to explicitly state what your plan is and what you are going to do.",
			"Break large tasks into mini-tasks proactively. Each mini-task should have a clear, achievable goal.",
			"Experiments and exploration are also mini-tasks. After the experiment, use mini_task_handoff to summarize findings and free context.",
			"Mini-tasks can be nested for finer-grained control. A sub-task's handoff returns to the parent task.",
			"Always call mini_task_start BEFORE starting the actual work, not after.",
		],
		parameters: StartParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!isEnabled) {
				return {
					content: [
						{
							type: "text",
							text: "Error: Mini-task management is disabled. Ask the user to run `/mini-task on` to enable it.",
						},
					],
				};
			}

			const sm = ctx.sessionManager;

			// Generate unique task ID
			const id = uniqueSlug(params.title, allTasksOnBranch);

			// Determine parent task implicitly from the active stack
			const parentId = taskStack.length > 0 ? taskStack[taskStack.length - 1].id : null;
			const startTag = `${id}-start`;

			// Build task data
			const task: MiniTaskData = {
				id,
				title: params.title,
				description: params.description || "",
				parentId,
				startTag,
				startEntryId: "", // Populated below
				status: "active",
			};

			// Persist in session
			pi.appendEntry("mini-task-start", task);

			// Create tag at current leaf position
			const startEntryId = sm.getLeafId();
			if (!startEntryId) {
				return {
					content: [
						{
							type: "text",
							text: "Error: No current position in session.",
						},
					],
				};
			}

			pi.setLabel(startEntryId, startTag);
			task.startEntryId = startEntryId;

			// Update in-memory state
			allTasksOnBranch.set(id, task);
			taskStack.push(task);

			const depth = taskStack.length;
			const parentInfo = parentId
				? `\n  Nested under: ${parentId}`
				: "\n  Top-level task";
			const depthInfo = `\n  Stack depth: ${depth}`;

			return {
				content: [
					{
						type: "text",
						text: `Started mini-task: ${id}${parentInfo}${depthInfo}\n  Tag: ${startTag}\n\nWork on this task now. When done, call mini_task_handoff with a summary to compress context.`,
					},
				],
				details: { id, startTag, depth, parentId },
			};
		},

		renderCall(args, theme) {
			const title = args.title || "untitled";
			return new Text(
				theme.fg("toolTitle", theme.bold("mini_task_start ")) +
					theme.fg("muted", `"${title}"`),
				0,
				0,
			);
		},

		renderResult(result, _options, theme) {
			const text = result.content[0];
			const msg = text?.type === "text" ? text.text : "";
			const firstLine = msg.split("\n")[0] || "Started";
			return new Text(
				theme.fg("success", "\u25b6 ") + theme.fg("muted", firstLine),
				0,
				0,
			);
		},
	});

	// -----------------------------------------------------------------------
	// mini_task_handoff tool
	// -----------------------------------------------------------------------

	pi.registerTool({
		name: "mini_task_handoff",
		label: "Mini Task Handoff",
		description:
			"Complete the current mini-task and compress its context. Generates a summary, then " +
			"navigates back to the task's start point via tree branching, replacing all intermediate " +
			"conversation with the summary. This frees context window space. For nested tasks, " +
			"the parent task resumes automatically.",
		promptSnippet: "Complete mini-task, compress context into summary",
		parameters: HandoffParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!isEnabled) {
				return {
					content: [
						{
							type: "text",
							text: "Error: Mini-task management is disabled. Ask the user to run `/mini-task on` to enable it.",
						},
					],
				};
			}

			// Check if enabled
			if (!commandCtx) {
				ctx.ui.setEditorText(
					`/mini-task continue`,
				);
				return {
					content: [
						{
							type: "text",
							text: "This is the first handoff of the session. A command has been placed in your editor. Please ask the user to press Enter to grant navigation permissions, then retry.",
						},
					],
				};
			}

			const currentTask = getCurrentTask();
			if (!currentTask) {
				return {
					content: [
						{
							type: "text",
							text: "No active mini-task to hand off. Start a task with mini_task_start first.",
						},
					],
				};
			}

			const sm = ctx.sessionManager;
			const currentLeaf = sm.getLeafId();

			// If already at the start, no compression needed
			if (currentLeaf === currentTask.startEntryId) {
				currentTask.status = "completed";
				pi.appendEntry("mini-task-complete", {
					id: currentTask.id,
					summary: params.summary,
					filesChanged: params.files_changed || [],
					decisions: params.decisions || [],
				});
				taskStack.pop();

				return {
					content: [
						{
							type: "text",
							text: `Mini-task "${currentTask.id}" completed (no context to compress).\n\nNext: ${params.next_step}`,
						},
					],
				};
			}

			// Build enriched summary
			const parts: string[] = [];
			parts.push(`[Mini-task: ${currentTask.id} \u2014 ${currentTask.title}]`);
			parts.push(`Status: Completed`);
			parts.push(`Summary: ${params.summary}`);

			if (params.files_changed?.length) {
				parts.push(`Files changed: ${params.files_changed.join(", ")}`);
			}
			if (params.decisions?.length) {
				parts.push(
					`Key decisions: ${params.decisions.join("; ")}`,
				);
			}
			if (params.findings) {
				parts.push(`Findings: ${params.findings}`);
			}

			parts.push(`Next Step: ${params.next_step}`);

			const enrichedSummary = parts.join("\n");

			// Create branch with summary (compress the task's conversation range)
			const currentLabel = currentLeaf
				? sm.getLabel(currentLeaf)
				: undefined;
			const origin = currentLabel
				? `tag: ${currentLabel}`
				: currentLeaf || "unknown";

			let newLeafId: string;
			try {
				newLeafId = (sm as any).branchWithSummary(
					currentTask.startEntryId,
					`(handoff from ${origin})\n${enrichedSummary}`,
					undefined,
					true
				);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [
						{
							type: "text",
							text: `Error during context compression: ${message}. Task "${currentTask.id}" is still active.`,
						},
					],
				};
			}

			// Mark task completed in session
			currentTask.status = "completed";

			// Update stack
			taskStack.pop();

			// Queue navigation for after agent ends
			pendingHandoff = {
				newLeafId,
				id: currentTask.id,
				parentId: currentTask.parentId,
				nextStep: params.next_step,
				summary: params.summary,
				filesChanged: params.files_changed || [],
				decisions: params.decisions || [],
			};

			return {
				content: [
					{
						type: "text",
						text: `Handoff initiated for "${currentTask.id}". The current turn will end and context will be compressed.`,
					},
				],
			};
		},

		renderCall(args, theme) {
			const preview =
				(args.summary || "").slice(0, 60) + (args.summary && args.summary.length > 60 ? "..." : "");
			return new Text(
				theme.fg("toolTitle", theme.bold("mini_task_handoff ")) +
					theme.fg("muted", preview),
				0,
				0,
			);
		},

		renderResult(result, _options, theme) {
			return new Text(
				theme.fg("success", "\u2713 ") +
					theme.fg("muted", "Context compression pending..."),
				0,
				0,
			);
		},
	});

	// -----------------------------------------------------------------------
	// mini_task_tree tool
	// -----------------------------------------------------------------------

	pi.registerTool({
		name: "mini_task_tree",
		label: "Mini Task Tree",
		description:
			"Show the tree of all mini-tasks in this session: their status, nesting, " +
			"and the current active stack. Use this to orient yourself on where you are " +
			"in the task hierarchy.",
		promptSnippet: "Show mini-task tree and status",
		parameters: TreeParams,

		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const sm = ctx.sessionManager;

			// Scan active branch for complete task history
			const allEntries = sm.getBranch();
			const allTasks: Map<string, MiniTaskData> = new Map();

			for (const entry of allEntries) {
				if (entry.type !== "custom") continue;

				if (entry.customType === "mini-task-start") {
					const data = entry.data as MiniTaskData | undefined;
					if (data) allTasks.set(data.id, { ...data, status: "active" });
				}

				if (entry.customType === "mini-task-complete") {
					const data = entry.data as { id: string } | undefined;
					if (data) {
						const task = allTasks.get(data.id);
						if (task) task.status = "completed";
					}
				}
			}

			const lines: string[] = [];

			// Header
			lines.push("\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550");
			lines.push("        Mini-Task Dashboard");
			lines.push("\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550");
			lines.push("");

			// Context usage
			const usage = await ctx.getContextUsage();
			if (usage) {
				const pct = usage.percent.toFixed(1);
				lines.push(`Context: ${pct}% used`);
			}

			// Task tree
			lines.push("");
			if (allTasks.size === 0) {
				lines.push("No mini-tasks in this session.");
			} else {
				const completed = [...allTasks.values()].filter(
					(t) => t.status === "completed",
				).length;
				lines.push(
					`Tasks: ${completed}/${allTasks.size} completed`,
				);
				lines.push("");

				const roots = [...allTasks.values()].filter(
					(t) => !t.parentId,
				);

				function renderTask(task: MiniTaskData, depth: number) {
					const indent = "  ".repeat(depth);
					const icon =
						task.status === "completed" ? "\u2713" : "\u25cf";
					lines.push(
						`${indent}${icon} ${task.id}: ${task.title}`,
					);
					if (task.description) {
						lines.push(
							`${indent}  ${task.description.slice(0, 80)}`,
						);
					}
					const children = [...allTasks.values()].filter(
						(t) => t.parentId === task.id,
					);
					for (const child of children) renderTask(child, depth + 1);
				}

				for (const root of roots) renderTask(root, 0);
			}

			// Active stack
			lines.push("");
			if (taskStack.length > 0) {
				lines.push("Active stack (innermost first):");
				for (let i = taskStack.length - 1; i >= 0; i--) {
					const t = taskStack[i];
					const prefix = i === taskStack.length - 1 ? "\u2192 " : "  ";
					lines.push(`  ${prefix}${t.id}: ${t.title}`);
				}
			} else {
				lines.push("No active tasks.");
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {},
			};
		},

		renderCall(_args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("mini_task_tree")),
				0,
				0,
			);
		},

		renderResult(result, _options, theme) {
			const text = result.content[0];
			const msg = text?.type === "text" ? text.text : "";
			const lines = msg.split("\n");
			// Show header + first few lines
			const preview = lines.slice(0, 6).join("\n");
			return new Text(
				theme.fg("muted", preview),
				0,
				0,
			);
		},
	});

	// -----------------------------------------------------------------------
	// Event handlers for handoff flow
	// -----------------------------------------------------------------------

	pi.on("turn_end", async (_event, ctx) => {
		if (!pendingHandoff) return;
		// Abort the current turn to prevent further tool calls
		ctx.abort();
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!pendingHandoff || !commandCtx) return;

		const handoff = pendingHandoff;
		pendingHandoff = null;

		// Navigate to the compressed branch
		await commandCtx.navigateTree(handoff.newLeafId, {
			summarize: false,
		});

		pi.appendEntry("mini-task-complete", {
			id: handoff.id,
			summary: handoff.summary,
			filesChanged: handoff.filesChanged,
			decisions: handoff.decisions,
		});

		// Force state reconstruction to include the newly appended completion entry
		reconstructState(ctx);
		updateWidget(ctx);

		ctx.ui.notify(
			`Compressed mini-task "${handoff.id}". Context freed.`,
			"info",
		);

		// Inject continuation message for the LLM
		const parentInfo = handoff.parentId
			? ` (resuming parent: ${handoff.parentId})`
			: "";

		pi.sendMessage(
			{
				customType: "mini-task",
				content: `mini_task_handoff complete for "${handoff.id}"${parentInfo}. Context has been compressed into a summary above. Read the summary to understand your current state, then: ${handoff.nextStep}`,
				display: false,
			},
			{
				triggerTurn: true,
			},
		);
	});

	// -----------------------------------------------------------------------
	// Widget: show active task above editor
	// -----------------------------------------------------------------------

	pi.on("tool_execution_end", async (event, ctx) => {
		if (event.toolName === "mini_task_start" || event.toolName === "mini_task_handoff") {
			updateWidget(ctx);
		}
	});
}
