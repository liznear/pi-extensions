/**
 * PROTOTYPE (throwaway) — wayfinder ticket 05: dashboard state derivation.
 *
 * The question: can the event stream actually drive the TUI? This module is
 * the proof — a pure reducer that folds the event log into the dashboard's
 * views. No I/O, no ANSI; liftable into the real extension.
 *
 * Correlation model: events are self-contained facts keyed by stable ids
 * (actor names, msg_id, task_id). Views are derived, never carried — the
 * reducer holds joins that the raw stream doesn't (msg→channel→recipient,
 * blackboard-style task states, iteration counters per channel).
 */

import type { GraphEvent } from "./events"

export type ActorState =
	| "planned" // registered, not spawned (per_task at create_task)
	| "thinking" // agent turn running, no tool active
	| "executing" // a tool call is active
	| "idle" // spawned, no turn running
	| "exited"

export interface ActorView {
	actor: string
	role: string
	task_id: string | null
	state: ActorState
	/** last tool detail line for the executing state */
	last_tool?: string
	session_id?: string
}

export interface MessageView {
	msg_id: string
	msg_type: string
	task_id: string | null
	from: string
	iteration?: number
	channel?: string
	/** filled by message_delivered events (multicast = many) */
	delivered_to: { actor: string; delivery: string }[]
	payload_preview: string
	emitted_at: number
}

export type TaskStatus = "planned" | "in_progress" | "done" | "failed"

export interface TaskView {
	task_id: string
	summary: string
	status: TaskStatus
	created_by: string
	/** derived from message views: latest iteration seen per channel id */
	iterations: Record<string, { n: number; max?: number }>
	merge?: { state: "ok" | "conflict"; commit?: string; files?: string[] }
}

export interface DashboardState {
	run: {
		run_id: string
		graph_id: string
		started_at?: number
		status: "running" | "completed" | "failed" | "aborted"
		workspace_mode?: string
	}
	actors: Record<string, ActorView>
	tasks: Record<string, TaskView>
	messages: MessageView[]
	/** rolling tail of notable events (emit/route/deliver/refuse/merge/steer) */
	flow: FlowLine[]
	last_seq: number
}

export interface FlowLine {
	seq: number
	ts: number
	kind: "emit" | "route" | "deliver" | "refuse" | "merge" | "steer" | "task"
	text: string
}

export function initState(
	run_id = "run-demo",
	graph_id = "review-pipeline",
): DashboardState {
	return {
		run: { run_id, graph_id, status: "running" },
		actors: {},
		tasks: {},
		messages: [],
		flow: [],
		last_seq: 0,
	}
}

const FLOW_TAIL = 8

function flow(
	s: DashboardState,
	e: GraphEvent,
	kind: FlowLine["kind"],
	text: string,
) {
	s.flow.push({ seq: e.seq, ts: e.ts, kind, text })
	if (s.flow.length > FLOW_TAIL) s.flow.shift()
}

export function fold(state: DashboardState, e: GraphEvent): DashboardState {
	// mutate-and-return: the TUI owns the single state object; cheap for a demo.
	const s = state
	s.last_seq = e.seq

	switch (e.type) {
		case "graph_started":
			s.run.started_at = e.ts
			s.run.workspace_mode = e.workspace_mode
			break
		case "graph_completed":
			s.run.status = "completed"
			break
		case "graph_failed":
			s.run.status = "failed"
			break
		case "graph_aborted":
			s.run.status = "aborted"
			break

		case "task_created": {
			s.tasks[e.task_id] = {
				task_id: e.task_id,
				summary: e.summary,
				status: "in_progress",
				created_by: e.by,
				iterations: {},
			}
			flow(s, e, "task", `task ${e.task_id} created by ${e.by}: ${e.summary}`)
			break
		}
		case "task_done": {
			const t = s.tasks[e.task_id]
			if (t) t.status = "done"
			flow(s, e, "task", `task ${e.task_id} DONE (via ${e.via})`)
			break
		}
		case "task_failed": {
			const t = s.tasks[e.task_id]
			if (t) t.status = "failed"
			flow(s, e, "task", `task ${e.task_id} FAILED: ${e.error}`)
			break
		}

		case "actor_planned":
			s.actors[e.actor] = {
				actor: e.actor,
				role: e.role,
				task_id: e.task_id,
				state: "planned",
			}
			break
		case "actor_spawned":
			s.actors[e.actor] = {
				actor: e.actor,
				role: e.role,
				task_id: e.task_id,
				state: "idle",
				session_id: e.session_id,
			}
			break
		case "actor_busy":
			if (s.actors[e.actor]) s.actors[e.actor].state = "thinking"
			break
		case "actor_idle":
			if (s.actors[e.actor]) s.actors[e.actor].state = "idle"
			break
		case "actor_tool": {
			const a = s.actors[e.actor]
			if (a) {
				a.state = e.phase === "start" ? "executing" : "thinking"
				a.last_tool = `${e.tool}${e.phase === "end" ? (e.ok ? "✓" : "✗") : ""}${e.detail ? ` (${e.detail})` : ""}`
			}
			break
		}
		case "actor_exited":
			if (s.actors[e.actor]) s.actors[e.actor].state = "exited"
			break

		case "message_emitted": {
			s.messages.push({
				msg_id: e.msg_id,
				msg_type: e.msg_type,
				task_id: e.task_id,
				from: e.actor,
				delivered_to: [],
				payload_preview: e.payload_preview,
				emitted_at: e.ts,
			})
			flow(
				s,
				e,
				"emit",
				e.via === "synthesized"
					? `runner ⊙ synthesized ${e.msg_type}`
					: `${e.actor} → emit ${e.msg_type}`,
			)
			break
		}
		case "emit_refused": {
			const q = e.quota ? ` [${e.quota.used}/${e.quota.max_per_task}]` : ""
			flow(
				s,
				e,
				"refuse",
				`${e.actor} emit ${e.msg_type} REFUSED${q}: ${e.reason}`,
			)
			break
		}
		case "message_routed": {
			const m = s.messages.find((x) => x.msg_id === e.msg_id)
			if (m) {
				m.channel = e.channel
				m.iteration = e.iteration
			}
			const task = e.task_id ? s.tasks[e.task_id] : undefined
			if (task) {
				const prev = task.iterations[e.channel]?.n ?? 0
				task.iterations[e.channel] = {
					n: Math.max(prev, e.iteration),
					max: e.iteration_max,
				}
			}
			flow(
				s,
				e,
				"route",
				`${e.msg_id} routed via ${e.channel} (iter ${e.iteration}${e.iteration_max ? `/${e.iteration_max}` : ""})`,
			)
			break
		}
		case "message_delivered": {
			const m = s.messages.find((x) => x.msg_id === e.msg_id)
			if (m) m.delivered_to.push({ actor: e.to, delivery: e.delivery })
			flow(s, e, "deliver", `${e.msg_id} delivered → ${e.to} (${e.delivery})`)
			break
		}

		case "worktree_created":
			break // path already visible via task row / actor cwd; no state to derive
		case "worktree_deleted":
			break // post-merge cleanup; task row already reflects merge_succeeded
		case "merge_attempted": {
			// clears a previous conflict display while the retry is in flight
			const t = s.tasks[e.task_id]
			if (t) t.merge = { state: "ok" }
			break
		}
		case "merge_succeeded": {
			const t = s.tasks[e.task_id]
			if (t) t.merge = { state: "ok", commit: e.commit }
			flow(s, e, "merge", `task ${e.task_id} merged @ ${e.commit.slice(0, 7)}`)
			break
		}
		case "merge_conflicted": {
			const t = s.tasks[e.task_id]
			if (t) t.merge = { state: "conflict", files: e.files }
			flow(
				s,
				e,
				"merge",
				`task ${e.task_id} merge CONFLICT (${e.files.length} files)`,
			)
			break
		}

		case "steer_sent":
			flow(s, e, "steer", `steer ${e.actor}: "${e.text_preview}"`)
			break
		default: {
			// exhaustiveness guard: a new event type must get a case (or land here
			// as a compile error), so the reducer can never silently drop events
			const _exhaustive: never = e
			return _exhaustive
		}
	}

	return s
}
