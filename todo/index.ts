import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type, type Static } from "@sinclair/typebox";

type TodoStatus = "pending" | "wip" | "completed" | "cancelled";

type TodoItem = {
	order: number;
	description: string;
	status: TodoStatus;
};

type TodoSnapshotItem = TodoItem;

const STATUS_VALUES = ["pending", "wip", "completed", "cancelled"] as const;

const todoWriteSchema = Type.Object({
	items: Type.Array(
		Type.Object({
			order: Type.Number({ description: "Sort order of the item (1..N)", minimum: 1 }),
			description: Type.String({ description: "Todo text" }),
			status: StringEnum(STATUS_VALUES),
		}),
		{ description: "Full todo list snapshot. Always pass all items." },
	),
});

type TodoWriteInput = Static<typeof todoWriteSchema>;

function isTodoStatus(value: unknown): value is TodoStatus {
	return typeof value === "string" && STATUS_VALUES.includes(value as TodoStatus);
}

function normalizeTodos(input: TodoSnapshotItem[]): { ok: true; items: TodoItem[] } | { ok: false; error: string } {
	const items: TodoItem[] = [];
	const seen = new Set<number>();

	for (const [i, t] of input.entries()) {
		if (!Number.isInteger(t.order) || t.order < 1) return { ok: false, error: `items[${i}].order must be integer >= 1` };
		if (seen.has(t.order)) return { ok: false, error: `items[${i}].order duplicates ${t.order}` };
		seen.add(t.order);
		
		const desc = t.description?.trim();
		if (!desc) return { ok: false, error: `items[${i}].description empty` };
		if (!isTodoStatus(t.status)) return { ok: false, error: `items[${i}].status invalid` };
		
		items.push({ order: t.order, description: desc, status: t.status });
	}

	return { ok: true, items: items.sort((a, b) => a.order - b.order) };
}

function coerceSnapshot(value: unknown): TodoItem[] | null {
	if (!Array.isArray(value)) return null;

	const rawItems = value.filter(i => i && typeof i === "object" && 
		typeof (i as any).order === "number" && 
		typeof (i as any).description === "string" && 
		isTodoStatus((i as any).status)
	) as TodoSnapshotItem[];
	
	if (rawItems.length !== value.length) return null;
	
	const normalized = normalizeTodos(rawItems);
	return normalized.ok ? normalized.items : null;
}

export default function todoExtension(pi: ExtensionAPI): void {
	let todos: TodoItem[] = [];

	const cloneTodos = () => todos.map((item) => ({ ...item }));

	const formatTodoList = () => {
		if (todos.length === 0) return "No todo items.";

		const iconByStatus: Record<TodoStatus, string> = {
			pending: "[ ]",
			wip: "[*]",
			completed: "[✓]",
			cancelled: "[x]",
		};

		return todos
			.map((item) => `${item.order}. ${iconByStatus[item.status]} ${item.description}`)
			.join("\n");
	};

	const broadcastTodos = (source: "session_start" | "tool_write") => {
		pi.events.emit("todo:updated", {
			source,
			timestamp: Date.now(),
			items: cloneTodos(),
		});
	};

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
			payload.reply(cloneTodos());
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		todos = [];

		const branch = ctx.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i] as any;
			if (entry?.type !== "message" || entry.message?.role !== "toolResult" || entry.message?.toolName !== "todo_write") continue;

			const snapshot = coerceSnapshot(entry.message?.details?.todos);
			if (snapshot) {
				todos = snapshot;
				break;
			}
		}

		broadcastTodos("session_start");
	});

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
		async execute(_toolCallId, params: TodoWriteInput) {
			const normalized = normalizeTodos(params.items);
			if (!normalized.ok) {
				return {
					isError: true,
					content: [{ type: "text", text: `todo_write rejected input: ${normalized.error}` }],
					details: { todos: cloneTodos() },
				};
			}

			todos = normalized.items;
			const summary = formatTodoList();

			broadcastTodos("tool_write");

			return {
				content: [{ type: "text", text: summary }],
				details: {
					todos: cloneTodos(),
					count: todos.length,
				},
			};
		},
	});

	pi.registerCommand("todo", {
		description: "Show current todo list managed by todo_write",
		handler: async (_args, ctx) => {
			ctx.ui.notify(formatTodoList(), "info");
		},
	});
}
