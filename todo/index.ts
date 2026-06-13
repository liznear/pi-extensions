import { StringEnum } from "@mariozechner/pi-ai"
import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@mariozechner/pi-coding-agent"
import { Text, truncateToWidth } from "@mariozechner/pi-tui"
import { type Static, Type } from "@sinclair/typebox"

type TodoStatus = "pending" | "wip" | "completed" | "cancelled"

type TodoItem = {
	order: number
	description: string
	status: TodoStatus
}

type TodoSnapshotItem = TodoItem

const STATUS_VALUES = ["pending", "wip", "completed", "cancelled"] as const

const todoWriteSchema = Type.Object({
	items: Type.Array(
		Type.Object({
			order: Type.Number({
				description: "Sort order of the item (1..N)",
				minimum: 1,
			}),
			description: Type.String({ description: "Todo text" }),
			status: StringEnum(STATUS_VALUES),
		}),
		{ description: "Full todo list snapshot. Always pass all items." },
	),
})

type TodoWriteInput = Static<typeof todoWriteSchema>

function isTodoStatus(value: unknown): value is TodoStatus {
	return (
		typeof value === "string" && STATUS_VALUES.includes(value as TodoStatus)
	)
}

function normalizeTodos(
	input: TodoSnapshotItem[],
): { ok: true; items: TodoItem[] } | { ok: false; error: string } {
	const items: TodoItem[] = []
	const seen = new Set<number>()

	for (const [i, t] of input.entries()) {
		if (!Number.isInteger(t.order) || t.order < 1)
			return { ok: false, error: `items[${i}].order must be integer >= 1` }
		if (seen.has(t.order))
			return { ok: false, error: `items[${i}].order duplicates ${t.order}` }
		seen.add(t.order)

		const desc = t.description?.trim()
		if (!desc) return { ok: false, error: `items[${i}].description empty` }
		if (!isTodoStatus(t.status))
			return { ok: false, error: `items[${i}].status invalid` }

		items.push({ order: t.order, description: desc, status: t.status })
	}

	return { ok: true, items: items.sort((a, b) => a.order - b.order) }
}

function coerceSnapshot(value: unknown): TodoItem[] | null {
	if (!Array.isArray(value)) return null

	const rawItems = value.filter(
		(i) =>
			i &&
			typeof i === "object" &&
			typeof (i as any).order === "number" &&
			typeof (i as any).description === "string" &&
			isTodoStatus((i as any).status),
	) as TodoSnapshotItem[]

	if (rawItems.length !== value.length) return null

	const normalized = normalizeTodos(rawItems)
	return normalized.ok ? normalized.items : null
}

export default function todoExtension(pi: ExtensionAPI): void {
	let todos: TodoItem[] = []

	const cloneTodos = () => todos.map((item) => ({ ...item }))

	const createTodoWidget = () => {
		if (todos.length === 0) return undefined

		return (_tui: unknown, theme: Theme) => ({
			invalidate() {},
			render(width: number): string[] {
				const activeTodos = todos.filter(
					(item) => item.status !== "completed" && item.status !== "cancelled",
				).length
				const completedTodos = todos.filter(
					(item) => item.status === "completed",
				).length
				const summary = `${activeTodos} active · ${completedTodos}/${todos.length} done`
				const title = `${theme.fg("accent", theme.bold("TODOs"))}  ${theme.fg("dim", summary)}`

				const lines = [truncateToWidth(` ${title}`, width)]
				for (const [index, item] of todos.entries()) {
					const status = {
						pending: { icon: "○", color: "dim" as const },
						wip: { icon: "●", color: "warning" as const },
						completed: { icon: "✓", color: "success" as const },
						cancelled: { icon: "×", color: "error" as const },
					}[item.status]
					const branch = index === todos.length - 1 ? "┗━" : "┣━"
					const description =
						item.status === "completed" || item.status === "cancelled"
							? theme.fg("dim", item.description)
							: theme.fg("text", item.description)
					lines.push(
						truncateToWidth(
							`  ${theme.fg("dim", branch)} ${theme.fg(status.color, status.icon)} ${description}`,
							width,
						),
					)
				}

				return lines
			},
		})
	}

	const updateTodoWidget = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return
		ctx.ui.setWidget("todo", createTodoWidget(), { placement: "aboveEditor" })
	}

	const formatTodoList = () => {
		if (todos.length === 0) return "No todo items."

		const iconByStatus: Record<TodoStatus, string> = {
			pending: "[ ]",
			wip: "[*]",
			completed: "[✓]",
			cancelled: "[x]",
		}

		return todos
			.map(
				(item) =>
					`${item.order}. ${iconByStatus[item.status]} ${item.description}`,
			)
			.join("\n")
	}

	const broadcastTodos = (source: "session_start" | "tool_write") => {
		pi.events.emit("todo:updated", {
			source,
			timestamp: Date.now(),
			items: cloneTodos(),
		})
	}

	// For other extensions:
	//   pi.events.on("todo:updated", ({ items }) => { ... })
	//   pi.events.emit("todo:get", { reply: (items) => { ... } })
	pi.events.on("todo:get", (payload) => {
		if (
			payload &&
			typeof payload === "object" &&
			"reply" in payload &&
			typeof payload.reply === "function"
		) {
			payload.reply(cloneTodos())
		}
	})

	const restoreTodosFromBranch = (ctx: ExtensionContext) => {
		todos = []

		const branch = ctx.sessionManager.getBranch()
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i] as any
			if (
				entry?.type !== "message" ||
				entry.message?.role !== "toolResult" ||
				entry.message?.toolName !== "todo_write"
			)
				continue

			const snapshot = coerceSnapshot(entry.message?.details?.todos)
			if (snapshot) {
				todos = snapshot
				break
			}
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		restoreTodosFromBranch(ctx)
		updateTodoWidget(ctx)
		broadcastTodos("session_start")
	})

	pi.on("session_tree", async (_event, ctx) => {
		restoreTodosFromBranch(ctx)
		updateTodoWidget(ctx)
		broadcastTodos("session_start")
	})

	pi.registerTool({
		name: "todo_write",
		label: "Todo Write",
		description:
			"Replace the full ordered todo list. Each item must include order, description, and status.",
		promptSnippet:
			"Persist the full ordered todo list as structured items with status values pending|wip|completed|cancelled.",
		promptGuidelines: [
			"Always send the entire todo list in todo_write.items, not partial updates.",
			"Keep item.order unique and stable to preserve task ordering.",
		],
		parameters: todoWriteSchema,
		renderCall(_args, theme, context) {
			const text =
				(context.lastComponent as Text | undefined) ?? new Text("", 0, 0)
			text.setText(theme.fg("toolTitle", theme.bold("todo_write")))
			return text
		},
		renderResult(result, options, theme, context) {
			const text =
				(context.lastComponent as Text | undefined) ?? new Text("", 0, 0)
			if (options.isPartial) {
				text.setText(theme.fg("muted", "Updating todos..."))
				return text
			}
			if (!options.expanded) {
				text.setText("")
				return text
			}
			text.setText(
				result.content?.[0]?.type === "text" ? result.content[0].text : "",
			)
			return text
		},
		async execute(
			_toolCallId,
			params: TodoWriteInput,
			_signal,
			_onUpdate,
			ctx,
		) {
			const normalized = normalizeTodos(params.items)
			if (!normalized.ok) {
				return {
					isError: true,
					content: [
						{
							type: "text",
							text: `todo_write rejected input: ${normalized.error}`,
						},
					],
					details: { todos: cloneTodos() },
				}
			}

			todos = normalized.items
			const summary = formatTodoList()

			updateTodoWidget(ctx)
			broadcastTodos("tool_write")

			return {
				content: [{ type: "text", text: summary }],
				details: {
					todos: cloneTodos(),
					count: todos.length,
				},
			}
		},
	})

	pi.registerCommand("todo", {
		description: "Show current todo list managed by todo_write",
		handler: async (_args, ctx) => {
			ctx.ui.notify(formatTodoList(), "info")
		},
	})
}
