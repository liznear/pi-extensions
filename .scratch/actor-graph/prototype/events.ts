/**
 * PROTOTYPE (throwaway) — wayfinder ticket 05: actor-graph event schema.
 *
 * The question this artifact answers: what event stream suffices to render
 * the graph dashboard (and to rebuild run state on resume — ticket 04)?
 *
 * This module is the part worth keeping: pure types, no I/O, no ANSI.
 * Everything here is under review and expected to change.
 */

/**
 * Envelope stamped by the runner (coordinator) on every event.
 * Ordering guarantee: (run_id, seq) is total and gap-free — seq doubles as
 * the resume/replay cursor (an emit already in the log is processed).
 */
export interface Envelope {
	v: 1
	/** run-local, gap-free, monotonic */
	seq: number
	/** epoch ms */
	ts: number
	run_id: string
	graph_id: string
}

// ---------------------------------------------------------------
// Family: graph lifecycle
// ---------------------------------------------------------------

export interface GraphStarted extends Envelope {
	type: "graph_started"
	workspace_mode: "worktree" | "shared"
	graph_file: string
}

export interface GraphCompleted extends Envelope {
	type: "graph_completed"
}

export interface GraphFailed extends Envelope {
	type: "graph_failed"
	error: string
}

export interface GraphAborted extends Envelope {
	type: "graph_aborted"
	by: string
}

// ---------------------------------------------------------------
// Family: task lifecycle
// ---------------------------------------------------------------

export interface TaskCreated extends Envelope {
	type: "task_created"
	task_id: string
	/** actor that called create_task */
	by: string
	summary: string
}

export interface TaskDone extends Envelope {
	type: "task_done"
	task_id: string
	via: "complete_task" | "task_complete_type"
	/** the synthesized task_done message, if one flowed on */
	msg_id?: string
}

export interface TaskFailed extends Envelope {
	type: "task_failed"
	task_id: string
	error: string
}

// ---------------------------------------------------------------
// Family: actor lifecycle
// ---------------------------------------------------------------

/** per_task node registered at create_task — no session yet (planned). */
export interface ActorPlanned extends Envelope {
	type: "actor_planned"
	/** Pi session name, e.g. "coder-for-task-1" (stable identity) */
	actor: string
	role: string
	task_id: string
}

/** session object exists (eager singleton, or lazy spawn on first routed message). */
export interface ActorSpawned extends Envelope {
	type: "actor_spawned"
	actor: string
	role: string
	/** null for singletons */
	task_id: string | null
	session_id: string
	cwd: string
}

/** state transitions — coordinator collapses fine-grained Pi agent events. */
export interface ActorBusy extends Envelope {
	type: "actor_busy"
	actor: string
}

export interface ActorIdle extends Envelope {
	type: "actor_idle"
	actor: string
}

/** collapsed tool execution (bash, read, emit, create_task, complete_task, ...). */
export interface ActorTool extends Envelope {
	type: "actor_tool"
	actor: string
	tool: string
	phase: "start" | "end"
	ok?: boolean
	/** one-line detail, e.g. exit code, file path, msg_type */
	detail?: string
}

export interface ActorExited extends Envelope {
	type: "actor_exited"
	actor: string
	reason: "disposed" | "crashed" | string
}

// ---------------------------------------------------------------
// Family: message flow (ticket 02 envelope traversal)
// ---------------------------------------------------------------

export interface MessageEmitted extends Envelope {
	type: "message_emitted"
	msg_id: string
	msg_type: string
	/** null for graph-scope messages */
	task_id: string | null
	/** ≤200 chars. Full payloads never ride events (paths-not-content, ticket 04). */
	payload_preview: string
	/** sender, coordinator-stamped (anti-forgery) */
	actor: string
	role: string
	/** "emit" = actor emit tool; "synthesized" = runner-minted (e.g. task_done) */
	via: "emit" | "synthesized"
}

export interface EmitRefused extends Envelope {
	type: "emit_refused"
	actor: string
	role: string
	msg_type: string
	task_id: string | null
	reason: "quota_exhausted" | "undeclared_type" | "no_matching_channel"
	/** present when quota_exhausted (per (role, type, task) — grammar max_per_task) */
	quota?: { max_per_task: number; used: number }
	/** exact in-turn tool error text returned to the actor */
	error: string
}

export interface MessageRouted extends Envelope {
	type: "message_routed"
	msg_id: string
	/** self-sufficiency: raw log greppable by task without joins (2026-08-22 review) */
	task_id: string | null
	/** channel id that matched (≤1 by R11) */
	channel: string
	/** per (channel, task) counter at routing time — loop position */
	iteration: number
	/** quota ceiling when the routed type carries max_per_task (denorm for self-sufficiency) */
	iteration_max?: number
}

export interface MessageDelivered extends Envelope {
	type: "message_delivered"
	msg_id: string
	/** one event per recipient (multicast = N events) */
	to: string
	/** idle → triggerTurn = "triggered"; busy → steer queue = "steered" */
	delivery: "triggered" | "steered"
}

// ---------------------------------------------------------------
// Family: integration / workspace (ticket 04, worktree mode)
// ---------------------------------------------------------------

export interface WorktreeCreated extends Envelope {
	type: "worktree_created"
	task_id: string
	path: string
}

export interface WorktreeDeleted extends Envelope {
	type: "worktree_deleted"
	task_id: string
	path: string
}

export interface MergeAttempted extends Envelope {
	type: "merge_attempted"
	task_id: string
	actor: string
}

export interface MergeSucceeded extends Envelope {
	type: "merge_succeeded"
	task_id: string
	actor: string
	commit: string
	/** merge wall-clock duration (2026-08-22 review — attempt event kept, duration added) */
	duration_ms: number
}

export interface MergeConflicted extends Envelope {
	type: "merge_conflicted"
	task_id: string
	actor: string
	files: string[]
	/** exact tool error returned in-loop */
	error: string
	/** merge wall-clock duration (2026-08-22 review — attempt event kept, duration added) */
	duration_ms: number
}

// ---------------------------------------------------------------
// Family: human intervention (ticket 02)
// ---------------------------------------------------------------

export interface SteerSent extends Envelope {
	type: "steer_sent"
	actor: string
	/** ≤200 chars */
	text_preview: string
}

// ---------------------------------------------------------------
// Union
// ---------------------------------------------------------------

export type GraphEvent =
	| GraphStarted
	| GraphCompleted
	| GraphFailed
	| GraphAborted
	| TaskCreated
	| TaskDone
	| TaskFailed
	| ActorPlanned
	| ActorSpawned
	| ActorBusy
	| ActorIdle
	| ActorTool
	| ActorExited
	| MessageEmitted
	| EmitRefused
	| MessageRouted
	| MessageDelivered
	| WorktreeCreated
	| WorktreeDeleted
	| MergeAttempted
	| MergeSucceeded
	| MergeConflicted
	| SteerSent
