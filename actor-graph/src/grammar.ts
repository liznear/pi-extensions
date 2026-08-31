/**
 * Graph grammar v1 types (RFC §3; normative grammar:
 * .scratch/actor-graph/research/03-channels-grammar-final.md).
 * YAML shape, snake_case, mirrors the graph file 1:1 — the parser (ticket 10)
 * produces these. Channel `when` stays a raw expression string; the validator
 * (R3) pins it to `msg.type == <literal>`.
 */

export interface EmitDecl {
	type: string
	/** per-(role, type, task) quota; omit = free exchange */
	max_per_task?: number
}

export interface RoleDef {
	system_prompt?: string
	/** resolved relative to the graph file's directory */
	system_prompt_file?: string
	/** allowlist for built-in tools (emit rides it — spike lesson S1) */
	tools: string[]
	/** opt out of type-level graph-context injection (default false) */
	disable_graph_context?: boolean
	/** gates create_task tool injection (default false, R14) */
	can_create_tasks?: boolean
	emits?: EmitDecl[]
	receives?: string[]
}

export type Lifecycle = "singleton" | "per_task"

export interface NodeDef {
	/** single-role group */
	role?: string
	/** multi-role group (a per_task pipeline) */
	roles?: string[]
	lifecycle: Lifecycle
	/** worktree mode only: receives complete_task (R16) */
	owner?: string
}

export interface ChannelDef {
	id: string
	from: string
	/** explicit multicast */
	to: string | string[]
	/** v1: `msg.type == <literal>` only (R3) */
	when: string
	scoped_to: "task" | "graph"
}

export interface WorkspaceDef {
	mode: "worktree" | "shared"
	/** shared mode only: message type marking a task terminal (R15) */
	task_complete_type?: string
}

export interface GraphDef {
	/** display metadata; graph id = filename stem */
	graph?: string
	version: 1
	roles: Record<string, RoleDef>
	nodes: NodeDef[]
	channels: ChannelDef[]
	workspace: WorkspaceDef
}
