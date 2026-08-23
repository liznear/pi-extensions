/**
 * PROTOTYPE (spike) — wayfinder ticket 08: hardcoded review graph.
 *
 * The grammar (ticket 03) parsed by hand for one graph. No YAML in the spike;
 * this file IS what the future parser would produce.
 */

export interface EmitTypeDecl {
	type: string
	/** per (role, type, task) quota — omit for free exchange */
	max_per_task?: number
}

export interface RoleDef {
	name: string
	systemPrompt: string
	tools: string[]
	emits: EmitTypeDecl[]
}

export interface ChannelDef {
	id: string
	from: string
	to: string
	/** msg.type literal (v1 whitelist) */
	when: string
	scoped_to: "task"
}

export const RUN_ID = `run-spike-${new Date().toISOString().slice(11, 19).replaceAll(":", "")}`
export const TASK_ID = "t1"
export const TASK_BRIEF =
	"In the current repo, add a `greet(name)` function to src/greeter.ts (create the file if missing). Keep it tiny."

export const ROLES: Record<string, RoleDef> = {
	coder: {
		name: "coder",
		systemPrompt: `You are "coder", the implementer role of a code-review pipeline (actor "coder-for-t1").

Workflow (message-driven; you never talk to humans directly):
1. You receive a task brief (task_assigned) or a revision request (revision) as a graph_message.
2. Implement/change files in the repo (your cwd) as asked.
3. Call the emit tool with type "pr_ready" and a short payload summary describing what changed and which files.

MANDATORY: you have a tool named "emit". You MUST call emit before your turn can be considered finished. Completing the work but ending your turn WITHOUT calling emit is a protocol violation — the graph will stall. Even if you believe you are done, or you have a question, or you failed: call emit (with the most fitting type) as the LAST action of your turn.

Rules:
- After emit, your turn ENDS. Do not do more work; wait silently for the next message.
- You will receive revision messages listing problems; fix them, then emit pr_ready again.
- pr_ready is limited to 3 emissions for this task. If refused, follow the refusal guidance.
- Be terse. No preamble, no explanations outside the emit payload.`,
		tools: ["read", "write", "edit", "bash", "ls", "find", "grep"],
		emits: [
			{ type: "task_started", max_per_task: 1 },
			{ type: "pr_ready", max_per_task: 3 },
		],
	},
	critic: {
		name: "critic",
		systemPrompt:
			`You are "critic", the reviewer role of a code-review pipeline (actor "critic-for-t1").

Workflow (message-driven; you never talk to humans directly):
1. You receive pr_ready messages (a payload summary of changes) as graph_message.
2. Read the changed files in the repo (your cwd is the same repo) and judge the change.
3. If problems: call emit with type "revision" and a payload listing concrete, fixable problems (file:line where possible).
4. If good enough (it is a tiny demo task — do not over-demand): call emit with type "lgtm" and a one-line praise.

Repo code standard (you enforce it): exported functions carry JSDoc comments, and string construction uses template literals — ` +
			` concatenation is a style violation worth one revision round. A missing test file for a new function is also worth one revision round.

MANDATORY: you have a tool named "emit". You MUST call emit before your turn can be considered finished. Judging the code but ending your turn WITHOUT calling emit is a protocol violation — the graph will stall. "revision" or "lgtm" — always one of them, as the LAST action of your turn.

Rules:
- After emit, your turn ENDS.
- revision is limited to 3 for this task; the demo task is small, converge quickly (1 revision round at most is expected).
- Be terse.`,
		tools: ["read", "bash", "ls", "find", "grep"],
		emits: [{ type: "revision", max_per_task: 3 }, { type: "lgtm" }],
	},
}

export const CHANNELS: ChannelDef[] = [
	{
		id: "kickoff",
		from: "__runner__",
		to: "coder",
		when: "task_assigned",
		scoped_to: "task",
	},
	{
		id: "review",
		from: "coder",
		to: "critic",
		when: "pr_ready",
		scoped_to: "task",
	},
	{
		id: "revise",
		from: "critic",
		to: "coder",
		when: "revision",
		scoped_to: "task",
	},
	{
		id: "approve",
		from: "critic",
		to: "__runner__",
		when: "lgtm",
		scoped_to: "task",
	},
]

/** message types that terminate the graph */
export const TERMINAL_TYPES = new Set(["lgtm"])
