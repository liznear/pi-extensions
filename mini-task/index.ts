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
 * Warning!!!!:
 *   this requires a patch on Pi to set expandPromptTemplates as true in sendUserMessage.
 */

import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent"
import { matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui"
import { Type } from "typebox"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TaskStatus = "pending" | "wip" | "completed" | "cancelled"

interface PlannedTask {
	id: string
	title: string
	description?: string
	depends_on?: string[]
	status: TaskStatus
}

interface MiniTaskData {
	id: string
	title: string
	description: string
	parentId: string | null
	startTag: string
	startEntryId: string | null
	status: "active" | "completed"
}

interface PendingHandoff {
	task: MiniTaskData

	origin: string
	enrichedSummary: string
	nextStep: string
	summary: string
	filesChanged: string[]
	decisions: string[]
}

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

class State {
	taskStack: MiniTaskData[] = []
	pendingHandoff: PendingHandoff | null = null
	plannedTasks: PlannedTask[] = []

	// Map of all tasks in the current branch history, keyed by task `id`.
	// This map is rebuilt when we switch branch.
	allTasks: Map<string, MiniTaskData> = new Map()

	constructor(ctx: ExtensionContext) {
		this.taskStack = []
		this.allTasks = new Map()
		this.pendingHandoff = null
		this.plannedTasks = []

		const branch = ctx.sessionManager.getBranch()
		for (const entry of branch) {
			if (entry.type !== "custom") continue

			if (entry.customType === "mini-task-plan") {
				const data = entry.data as { tasks?: PlannedTask[] } | undefined
				if (data?.tasks) {
					this.plannedTasks = data.tasks.map((t) => ({
						...t,
						status: t.status || "pending",
					}))
				}
			}

			if (entry.customType === "mini-task-start") {
				const data = entry.data as MiniTaskData | undefined
				if (data) {
					// Reconstruct startEntryId: find the corresponding toolResult message in the branch
					let startEntryId = entry.id
					const branch = ctx.sessionManager.getBranch()
					const entryIndex = branch.findIndex((e) => e.id === entry.id)
					if (entryIndex !== -1) {
						// Look forward for the first toolResult of mini_task_start
						for (let i = entryIndex + 1; i < branch.length; i++) {
							const e = branch[i]
							if (
								e.type === "message" &&
								(e as { message?: { role?: string; toolName?: string } })
									.message?.role === "toolResult" &&
								(e as { message?: { role?: string; toolName?: string } })
									.message?.toolName === "mini_task_start"
							) {
								startEntryId = e.id
								break
							}
						}
					}

					this.allTasks.set(data.id, {
						...data,
						status: "active",
						startEntryId,
					})

					const plan = this.plannedTasks.find((p) => p.id === data.id)
					if (plan && plan.status === "pending") plan.status = "wip"
				}
			}

			if (entry.customType === "mini-task-complete") {
				const data = entry.data as {
					id?: string
					title?: string
					description?: string
					parentId?: string | null
				}
				if (data?.id) {
					const task = this.allTasks.get(data.id)
					if (task) {
						task.status = "completed"
					} else {
						// Reconstruct if the start entry was branched away
						this.allTasks.set(data.id, {
							id: data.id,
							title: data.title || data.id,
							description: data.description || "",
							parentId: data.parentId || null,
							startTag: `${data.id}-start`,
							startEntryId: null,
							status: "completed",
						})
					}

					const plan = this.plannedTasks.find((p) => p.id === data.id)
					if (plan) plan.status = "completed"
				}
			}
		}

		// Rebuild active stack in chronological order (Map iteration order matches insertion order)
		this.taskStack = [...this.allTasks.values()].filter(
			(t) => t.status === "active",
		)
	}

	empty(): boolean {
		return this.taskStack.length === 0
	}

	currentTask(): MiniTaskData | undefined {
		return this.empty() ? undefined : this.taskStack[this.taskStack.length - 1]
	}

	uniqueSlug(name: string): string {
		const slug =
			name
				.toLowerCase()
				.trim()
				.replace(/[^a-z0-9\s-]/g, "")
				.replace(/[\s]+/g, "-")
				.replace(/-+/g, "-")
				.replace(/^-|-$/g, "")
				.slice(0, 48) || "task"
		if (!this.allTasks.has(slug)) return slug
		let i = 2
		while (this.allTasks.has(`${slug}-${i}`)) i++
		return `${slug}-${i}`
	}

	startTask(task: MiniTaskData) {
		this.allTasks.set(task.id, task)
		this.taskStack.push(task)
	}
	handoffTask(): MiniTaskData | undefined {
		return this.taskStack.pop()
	}
}

// Enabled by default. Users can toggle with `/mini-task` and `/mini-task off`.
let isEnabled = true
// let commandCtx: ExtensionCommandContext | undefined
let state: State | undefined

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a task tree string for display. */
function renderTaskTree(
	tasks: Map<string, MiniTaskData>,
	theme: Theme,
): string[] {
	const lines: string[] = []
	const roots = [...tasks.values()].filter((t) => !t.parentId)

	function render(task: MiniTaskData, depth: number) {
		const indent = "  ".repeat(depth)
		const icon =
			task.status === "completed"
				? theme.fg("success", "✓")
				: theme.fg("accent", "●")
		const title =
			task.status === "completed"
				? theme.fg("dim", task.title)
				: theme.fg("text", task.title)
		const id = theme.fg("muted", task.id)

		lines.push(`${indent}${icon} ${id} ${title}`)

		const children = [...tasks.values()].filter((t) => t.parentId === task.id)
		for (const child of children) render(child, depth + 1)
	}

	for (const root of roots) render(root, 0)
	return lines
}

/** Update the active-task widget above the editor. */
function updateWidget(ctx: ExtensionContext, state: State) {
	if (state.plannedTasks.length === 0) {
		ctx.ui.setWidget("mini-task", undefined)
		return
	}

	ctx.ui.setWidget(
		"mini-task",
		(_tui: unknown, theme: Theme) => {
			return {
				invalidate() {},
				render(width: number): string[] {
					const activeTasks = state.plannedTasks.filter(
						(item) =>
							item.status !== "completed" && item.status !== "cancelled",
					).length
					const completedTasks = state.plannedTasks.filter(
						(item) => item.status === "completed",
					).length
					const summary = `${activeTasks} active \u00b7 ${completedTasks}/${state.plannedTasks.length} done`
					const title = `${theme.fg("accent", theme.bold("Mini Tasks"))}  ${theme.fg("dim", summary)}`

					const lines = [truncateToWidth(` ${title}`, width)]
					for (const [index, item] of state.plannedTasks.entries()) {
						const taskStatus = item.status || "pending"
						const status = {
							pending: { icon: "\u25cb", color: "dim" as const },
							wip: { icon: "\u25cf", color: "warning" as const },
							completed: { icon: "\u2713", color: "success" as const },
							cancelled: { icon: "\u00d7", color: "error" as const },
						}[taskStatus] || { icon: "\u25cb", color: "dim" as const }

						const branch =
							index === state.plannedTasks.length - 1
								? "\u2517\u2501"
								: "\u2523\u2501"
						const description =
							item.status === "completed" || item.status === "cancelled"
								? theme.fg("dim", `${item.id}: ${item.title}`)
								: theme.fg("text", `${item.id}: ${item.title}`)
						lines.push(
							truncateToWidth(
								`  ${theme.fg("dim", branch)} ${theme.fg(status.color, status.icon)} ${description}`,
								width,
							),
						)
					}
					return lines
				},
			}
		},
		{ placement: "aboveEditor" },
	)
}

// ---------------------------------------------------------------------------
// TUI Component: Task Dashboard
// ---------------------------------------------------------------------------

class TaskDashboardComponent {
	private tasks: Map<string, MiniTaskData>
	private stack: MiniTaskData[]
	private planned: PlannedTask[]
	private theme: Theme
	private onClose: () => void
	private cachedWidth?: number
	private cachedLines?: string[]

	constructor(state: State, theme: Theme, onClose: () => void) {
		this.tasks = state.allTasks
		this.stack = state.taskStack
		this.planned = state.plannedTasks
		this.theme = theme
		this.onClose = onClose
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onClose()
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines

		const th = this.theme
		const lines: string[] = []

		lines.push("")
		const title = th.fg("accent", " Mini-Task Dashboard ")
		const header =
			th.fg("borderMuted", "\u2500".repeat(3)) +
			title +
			th.fg("borderMuted", "\u2500".repeat(Math.max(0, width - 24)))
		lines.push(truncateToWidth(header, width))
		lines.push("")

		if (this.tasks.size === 0) {
			lines.push(
				truncateToWidth(
					`  ${th.fg("dim", "No mini-tasks yet. The LLM will create them as needed.")}`,
					width,
				),
			)
		} else {
			const treeLines = renderTaskTree(this.tasks, th)
			for (const line of treeLines) {
				lines.push(truncateToWidth(`  ${line}`, width))
			}
		}

		lines.push("")

		// Render planned tasks
		if (this.planned.length > 0) {
			lines.push(
				truncateToWidth(`  ${th.fg("muted", "Planned Tasks:")}`, width),
			)
			for (const p of this.planned) {
				const statusIcon =
					p.status === "completed"
						? th.fg("success", "\u2713")
						: p.status === "wip"
							? th.fg("warning", "\u25cf")
							: p.status === "cancelled"
								? th.fg("error", "\u00d7")
								: th.fg("dim", "\u25cb")

				const title =
					p.status === "completed" || p.status === "cancelled"
						? th.fg("dim", p.title)
						: th.fg("text", p.title)

				lines.push(
					truncateToWidth(
						`    ${statusIcon} ${th.fg("muted", p.id)}: ${title}`,
						width,
					),
				)
			}
			lines.push("")
		}

		if (this.stack.length > 0) {
			lines.push(truncateToWidth(`  ${th.fg("muted", "Active stack:")}`, width))
			for (let i = this.stack.length - 1; i >= 0; i--) {
				const t = this.stack[i]
				const depth = this.stack.length - 1 - i
				const indent = "    ".repeat(depth)
				const arrow =
					depth === 0 ? th.fg("accent", "\u2192") : th.fg("dim", "\u21b3")
				lines.push(
					truncateToWidth(
						`  ${indent}${arrow} ${th.fg("muted", t.id)}: ${th.fg("text", t.title)}`,
						width,
					),
				)
			}
		} else {
			lines.push(
				truncateToWidth(`  ${th.fg("dim", "No active tasks.")}`, width),
			)
		}

		lines.push("")
		lines.push(
			truncateToWidth(`  ${th.fg("dim", "Press Escape to close")}`, width),
		)
		lines.push("")

		this.cachedWidth = width
		this.cachedLines = lines
		return lines
	}

	invalidate(): void {
		this.cachedWidth = undefined
		this.cachedLines = undefined
	}
}

// ---------------------------------------------------------------------------
// Tool parameter schemas
// ---------------------------------------------------------------------------

const PlanParams = Type.Object({
	tasks: Type.Array(
		Type.Object({
			id: Type.String({
				description:
					"Unique, short slug identifier for this planned task (e.g. read-configs, implement-auth)",
			}),
			title: Type.String({
				description: "Short descriptive title of the planned task",
			}),
			description: Type.Optional(
				Type.String({
					description:
						"Detailed description of the task goals, success criteria, and resources/files to pre-read.",
				}),
			),
			depends_on: Type.Optional(
				Type.Array(Type.String(), {
					description: "Optional list of task IDs this task depends on",
				}),
			),
		}),
		{
			description:
				"Full list of planned tasks for this session (always overwrites previous plan)",
		},
	),
})

const StartParams = Type.Object({
	id: Type.String({
		description: "The ID of the planned task to start working on",
	}),
})

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
})

const TreeParams = Type.Object({})

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// Reconstruct state on session events
	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		isEnabled = true
		state = new State(ctx)
		updateWidget(ctx, state)
	})
	pi.on("session_tree", async (_event, ctx: ExtensionContext) => {
		state = new State(ctx)
		updateWidget(ctx, state)
	})

	// -----------------------------------------------------------------------
	// /mini-task command
	// -----------------------------------------------------------------------

	const disabledMessage: AgentToolResult<unknown> = {
		content: [
			{
				type: "text",
				text: "Error: Mini-task management is disabled. Ask the user to run `/mini-task on` to enable it.",
			},
		],
		details: {},
	}

	pi.registerCommand("mini-task", {
		description: "Toggle mini-task management (on/off)",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("mini-task requires interactive mode", "error")
				return
			}

			const arg = args.trim().toLowerCase()
			if (arg === "off") {
				isEnabled = false
				ctx.ui.notify("Mini-task management disabled", "info")
				return
			} else if (arg === "on") {
				isEnabled = true
				ctx.ui.notify("Mini-task management enabled", "info")
				return
			}

			if (!isEnabled) {
				return
			}

			// Show interactive dashboard
			await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
				if (!state) throw new Error("Mini-task state not initialized")
				return new TaskDashboardComponent(state, theme, () => done())
			})
		},
	})

	// This is not used yet. Use it after expandPromptTemplates is available.
	pi.registerCommand("mini-task-handoff", {
		description: "Internal command to handoff from a completed mini task",
		handler: async (_args, ctx) => {
			if (!isEnabled) {
				ctx.ui.notify("Mini-task management disabled", "info")
				return
			}

			await ctx.waitForIdle()

			if (!state?.pendingHandoff) return

			const handoff = state.pendingHandoff
			state.pendingHandoff = null

			const sm = ctx.sessionManager
			let newLeafId: string
			try {
				newLeafId = (
					sm as unknown as {
						branchWithSummary: (...args: unknown[]) => string
					}
				).branchWithSummary(
					handoff.task.startEntryId,
					`(handoff from ${handoff.origin})\n${handoff.enrichedSummary}`,
					undefined,
					true,
				)
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err)
				ctx.ui.notify(`Error during context compression: ${message}`, "error")
				return
			}

			// Navigate to the compressed branch
			await ctx.navigateTree(newLeafId, {
				summarize: false,
			})

			pi.appendEntry("mini-task-complete", {
				id: handoff.task.id,
				title: handoff.task.title,
				description: handoff.task.description,
				parentId: handoff.task.parentId,
				summary: handoff.summary,
				filesChanged: handoff.filesChanged,
				decisions: handoff.decisions,
			})

			// Force state reconstruction so the dashboard picks up the completed status on the new branch
			state = new State(ctx)

			// Manually enforce completed status on the state just in case session branch is cached
			const plan = state.plannedTasks.find((p) => p.id === handoff.task.id)
			if (plan) plan.status = "completed"
			const task = state.allTasks.get(handoff.task.id)
			if (task) task.status = "completed"

			updateWidget(ctx, state)

			ctx.ui.notify(
				`Compressed mini-task "${handoff.task.id}". Context freed.`,
				"info",
			)

			// Inject continuation message for the LLM
			const parentInfo = handoff.task.parentId
				? ` (resuming parent: ${handoff.task.parentId})`
				: ""

			pi.sendMessage(
				{
					customType: "mini-task",
					content: `mini_task_handoff complete for "${handoff.task.id}"${parentInfo}. Context has been compressed into a summary above. Read the summary to understand your current state, then: ${handoff.nextStep}`,
					display: false,
				},
				{
					triggerTurn: true,
				},
			)
		},
	})

	// -----------------------------------------------------------------------
	// mini_task_plan tool
	// -----------------------------------------------------------------------

	pi.registerTool({
		name: "mini_task_plan",
		label: "Mini Task Plan",
		description:
			"Plan ahead for the mini-tasks needed for this session. Always overwrites the existing plan. " +
			"Can be called at any point to update or refine the plan based on new findings. " +
			"Required before mini_task_start: a task cannot be started unless its id is in the plan.",
		promptSnippet: "Plan a list of mini-tasks ahead of executing them",
		promptGuidelines: [
			"Plan ahead: Use this tool at the very beginning of a session or whenever the plan needs to change.",
			"Required before start: mini_task_start rejects any task id not present in the plan, so always plan first.",
			"Include research/exploration/spike steps as their own tasks, not just implementation steps. Any step that gathers information to reach a conclusion — reading docs, benchmarking, investigating a library, debugging an unknown — should be a separate mini-task; at handoff only the conclusion is kept and the rest of the context is freed.",
			"Avoid over-granularity: If multiple upcoming mini-tasks require examining the same file or resource, read/inspect that resource first in the parent context before spawning child mini-tasks. This shares context across children and avoids redundant operations.",
			"Always list all outstanding steps in the tasks array, as each call overwrites the current plan.",
		],
		parameters: PlanParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!isEnabled || !state) {
				return disabledMessage
			}

			// Persist the plan in the session
			pi.appendEntry("mini-task-plan", {
				tasks: params.tasks,
			})

			// Force reconstruct state to reflect new plan
			state = new State(ctx)
			updateWidget(ctx, state)

			const lines: string[] = ["Overwrote current mini-task plan:"]
			for (const t of params.tasks) {
				lines.push(
					`- [ ] ${t.id}: ${t.title}${t.description ? ` (${t.description})` : ""}`,
				)
			}

			return {
				content: [
					{
						type: "text",
						text: lines.join("\n"),
					},
				],
				details: { tasks: params.tasks },
			}
		},

		renderCall(args, theme) {
			const count = args.tasks?.length ?? 0
			return new Text(
				theme.fg("toolTitle", theme.bold("mini_task_plan ")) +
					theme.fg("muted", `(${count} tasks planned)`),
				0,
				0,
			)
		},

		renderResult(result, _options, theme) {
			const text = result.content[0]
			const msg = text?.type === "text" ? text.text : ""
			const firstLine = msg.split("\n")[0] || "Planned"
			return new Text(
				theme.fg("success", "\u25b6 ") + theme.fg("muted", firstLine),
				0,
				0,
			)
		},
	})

	// -----------------------------------------------------------------------
	// mini_task_start tool
	// -----------------------------------------------------------------------

	pi.registerTool({
		name: "mini_task_start",
		label: "Mini Task Start",
		description:
			"Start a new tracked mini-task and create a save point in the conversation tree. " +
			"Use before ANY focused work — implementation, debugging, research, or exploration — to explicitly state your plan. " +
			"When the task completes, call mini_task_handoff to compress the work into a summary and free context. " +
			"The task id must already exist in the plan from a prior mini_task_plan call.",
		promptSnippet: "Explicitly state your plan and start a tracked mini-task",
		promptGuidelines: [
			"Plan first: the task id must already be in the plan from a prior mini_task_plan call; starting an unplanned task is rejected.",
			"Use mini_task_start before ANY focused work — implementation, debugging, research, or exploration. Wrapping a research/spike here compresses the whole investigation down to its conclusion at handoff, behaving like a sub-agent.",
			"Break large tasks into mini-tasks proactively. Each mini-task should have a clear, achievable goal.",
			"Mini-tasks can be nested for finer-grained control. A sub-task's handoff returns to the parent task.",
			"Always call mini_task_start BEFORE starting the actual work, not after.",
		],
		parameters: StartParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!isEnabled || !state) {
				return disabledMessage
			}
			const sm = ctx.sessionManager

			// Ensure the task exists in the plan
			const planned = state.plannedTasks.find((p) => p.id === params.id)
			if (!planned) {
				return {
					content: [
						{
							type: "text",
							text: `Error: Task ID "${params.id}" not found in the planned tasks. Use mini_task_plan to plan it first.`,
						},
					],
					details: {},
				}
			}

			// Use the planned task's id, title, and description
			const id = params.id
			const parentId = state.currentTask()?.id ?? null
			const startTag = `${id}-start`

			// Build task data
			const task: MiniTaskData = {
				id,
				title: planned.title,
				description: planned.description || "",
				parentId,
				startTag: startTag,
				startEntryId: sm.getLeafId(),
				status: "active",
			}

			// Persist in session
			pi.appendEntry("mini-task-start", task)
			// Update in-memory state
			state?.startTask(task)
			planned.status = "wip"

			const depth = state?.taskStack.length
			const parentInfo = parentId
				? `\n  Nested under: ${parentId}`
				: "\n  Top-level task"
			const depthInfo = `\n  Stack depth: ${depth}`

			return {
				content: [
					{
						type: "text",
						text: `Started mini-task: ${id}${parentInfo}${depthInfo}\n  Tag: ${startTag}\n\nFocus on this task now. When done, call mini_task_handoff with a summary to compress context.`,
					},
				],
				details: { id, startTag, depth, parentId },
			}
		},

		renderCall(args, theme) {
			const id = args.id || "unknown"
			return new Text(
				theme.fg("toolTitle", theme.bold("mini_task_start ")) +
					theme.fg("muted", `"${id}"`),
				0,
				0,
			)
		},

		renderResult(result, _options, theme) {
			const text = result.content[0]
			const msg = text?.type === "text" ? text.text : ""
			const firstLine = msg.split("\n")[0] || "Started"
			return new Text(
				theme.fg("success", "\u25b6 ") + theme.fg("muted", firstLine),
				0,
				0,
			)
		},
	})

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
			if (!isEnabled || !state) {
				return disabledMessage
			}

			// Validate we actually have a task to handoff, and peek before we pop
			const currentTaskPeek = state.currentTask()
			if (!currentTaskPeek) {
				return {
					content: [
						{
							type: "text",
							text: "No active mini-task to hand off. Start a task with mini_task_start first.",
						},
					],
					details: {},
				}
			}

			if (currentTaskPeek.status === "completed") {
				return {
					content: [
						{
							type: "text",
							text: `Error: The active task "${currentTaskPeek.id}" is already marked as completed. You cannot handoff a task that is already finished.`,
						},
					],
					details: {},
				}
			}

			// Safe to pop now
			const currentTask = state.handoffTask()
			if (!currentTask) {
				return {
					content: [
						{
							type: "text",
							text: "No active mini-task to hand off.",
						},
					],
					details: {},
				}
			}
			currentTask.status = "completed"
			const plan = state.plannedTasks.find((p) => p.id === currentTask.id)
			if (plan) plan.status = "completed"

			const currentLeaf = ctx.sessionManager.getLeafId()
			const currentLabel = currentLeaf
				? ctx.sessionManager.getLabel(currentLeaf)
				: undefined
			const origin = currentLabel
				? `tag: ${currentLabel}`
				: currentLeaf || "unknown"

			// If already at the start, no compression needed
			if (currentLeaf === currentTask.startEntryId) {
				pi.appendEntry("mini-task-complete", {
					id: currentTask.id,
					summary: params.summary,
					filesChanged: params.files_changed || [],
					decisions: params.decisions || [],
				})

				return {
					content: [
						{
							type: "text",
							text: `Mini-task "${currentTask.id}" completed (no context to compress).\n\nNext: ${params.next_step}`,
						},
					],
					details: {},
				}
			}

			// Build enriched summary
			const parts: string[] = []
			parts.push(`[Mini-task: ${currentTask.id} \u2014 ${currentTask.title}]`)
			parts.push(`Status: Completed`)
			parts.push(`Summary: ${params.summary}`)

			if (params.files_changed?.length) {
				parts.push(`Files changed: ${params.files_changed.join(", ")}`)
			}
			if (params.decisions?.length) {
				parts.push(`Key decisions: ${params.decisions.join("; ")}`)
			}
			if (params.findings) {
				parts.push(`Findings: ${params.findings}`)
			}

			parts.push(`Next Step: ${params.next_step}`)

			const enrichedSummary = parts.join("\n")

			// Defer branching until agent_end so the aborted message stays on the old branch
			currentTask.status = "completed"

			state.pendingHandoff = {
				task: currentTask,
				origin,
				enrichedSummary,
				nextStep: params.next_step,
				summary: params.summary,
				filesChanged: params.files_changed || [],
				decisions: params.decisions || [],
			}

			// We removed the appendEntry from here because branching from startTag
			// would orphan it on the old branch. It is now appended in the command handler
			// after branchWithSummary completes.

			pi.sendUserMessage("/mini-task-handoff", {
				deliverAs: "followUp",
			})
			return {
				content: [
					{
						type: "text",
						text: `Handoff initiated for "${currentTask.id}". The current turn will end and context will be compressed.`,
					},
				],
				details: {},
				terminate: true,
			}
		},

		renderCall(args, theme) {
			const preview =
				(args.summary || "").slice(0, 60) +
				(args.summary && args.summary.length > 60 ? "..." : "")
			return new Text(
				theme.fg("toolTitle", theme.bold("mini_task_handoff ")) +
					theme.fg("muted", preview),
				0,
				0,
			)
		},

		renderResult(_result, _options, theme) {
			return new Text(
				theme.fg("success", "\u2713 ") +
					theme.fg("muted", "Context compression pending..."),
				0,
				0,
			)
		},
	})

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
			if (!isEnabled || !state) {
				return disabledMessage
			}

			const lines: string[] = []

			// Header
			lines.push(
				"\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550",
			)
			lines.push("        Mini-Task Dashboard")
			lines.push(
				"\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550",
			)
			lines.push("")

			// Context usage
			const usage = ctx.getContextUsage()
			if (usage) {
				const pct = usage.percent?.toFixed(1)
				lines.push(`Context: ${pct}% used`)
			}

			// Task tree
			lines.push("")
			if (state.allTasks.size === 0) {
				lines.push("No mini-tasks in this session.")
			} else {
				const allTasks = state.allTasks
				const completed = [...allTasks.values()].filter(
					(t) => t.status === "completed",
				).length
				lines.push(`Tasks: ${completed}/${allTasks.size} completed`)
				lines.push("")

				const roots = [...allTasks.values()].filter((t) => !t.parentId)

				function renderTask(task: MiniTaskData, depth: number) {
					const indent = "  ".repeat(depth)
					const icon = task.status === "completed" ? "\u2713" : "\u25cf"
					lines.push(`${indent}${icon} ${task.id}: ${task.title}`)
					if (task.description) {
						lines.push(`${indent}  ${task.description.slice(0, 80)}`)
					}
					const children = [...allTasks.values()].filter(
						(t) => t.parentId === task.id,
					)
					for (const child of children) renderTask(child, depth + 1)
				}

				for (const root of roots) renderTask(root, 0)
			}

			// Planned tasks
			if (state.plannedTasks.length > 0) {
				lines.push("")
				lines.push("Planned tasks:")
				for (const p of state.plannedTasks) {
					const statusIcon =
						p.status === "completed"
							? "\u2713"
							: p.status === "wip"
								? "\u25cf"
								: p.status === "cancelled"
									? "\u00d7"
									: "\u25cb"
					lines.push(`  ${statusIcon} ${p.id}: ${p.title}`)
					if (p.description) {
						lines.push(`    ${p.description}`)
					}
				}
			}

			// Active stack
			lines.push("")
			if (!state.empty()) {
				lines.push("Active stack (innermost first):")
				for (let i = state.taskStack.length - 1; i >= 0; i--) {
					const t = state.taskStack[i]
					const prefix = i === state.taskStack.length - 1 ? "\u2192 " : "  "
					lines.push(`  ${prefix}${t.id}: ${t.title}`)
				}
			} else {
				lines.push("No active tasks.")
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {},
			}
		},

		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("mini_task_tree")), 0, 0)
		},
	})

	// -----------------------------------------------------------------------
	// Widget: show active task above editor
	// -----------------------------------------------------------------------

	pi.on("tool_execution_end", async (event, ctx) => {
		if (!isEnabled || !state) {
			return
		}
		if (
			event.toolName === "mini_task_start" ||
			event.toolName === "mini_task_handoff"
		) {
			updateWidget(ctx, state)
			if (event.toolName === "mini_task_start") {
				const task = state.currentTask()
				if (task && task.status === "active") {
					// The toolResult message is now the leaf. This is our true start point.
					task.startEntryId = ctx.sessionManager.getLeafId()
				}
			}
		}
	})
}
