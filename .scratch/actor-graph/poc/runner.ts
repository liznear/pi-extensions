/**
 * PROTOTYPE (spike) — wayfinder ticket 08: graph runner.
 *
 * Executes the hardcoded graph with REAL headless LLM sessions:
 * lazy spawn via the services path, per-role emit tool, quota'd channel
 * router, sendCustomMessage delivery, schema-v1 events → events.jsonl.
 * This is the seed of the real runner — the shape the RFC will size.
 */

import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import {
	type AgentSession,
	createAgentSessionFromServices,
	createAgentSessionServices,
	SessionManager,
} from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import type { GraphEvent } from "../prototype/events.ts"
import { CHANNELS, type ChannelDef, ROLES, TERMINAL_TYPES } from "./graph.ts"

// ------------------------------------------------------------------
// Event log — schema v1 (ticket 05), seq stamped here
// ------------------------------------------------------------------

/** Omit must distribute over the event union or per-variant fields collapse. */
type DistributiveOmit<T, K extends keyof T> = T extends unknown
	? Omit<T, K>
	: never
export type EventBody = DistributiveOmit<
	GraphEvent,
	"v" | "seq" | "ts" | "run_id" | "graph_id"
>

export class EventLog {
	seq = 0
	readonly dir: string

	constructor(
		readonly runId: string,
		readonly graphId: string,
	) {
		this.dir = join(process.cwd(), "runs", runId)
		mkdirSync(this.dir, { recursive: true })
	}

	emit(body: EventBody): GraphEvent {
		const e = {
			...body,
			v: 1 as const,
			seq: ++this.seq,
			ts: Date.now(),
			run_id: this.runId,
			graph_id: this.graphId,
		} as GraphEvent
		appendFileSync(join(this.dir, "events.jsonl"), `${JSON.stringify(e)}\n`)
		return e
	}
}

// ------------------------------------------------------------------
// Envelope (ticket 02) + router (ticket 03 semantics)
// ------------------------------------------------------------------

interface Envelope {
	msg_id: string
	type: string
	task_id: string
	payload: string
	sender: string
	role: string
	channel?: string
	iteration?: number
}

let msgCounter = 0
const nextMsgId = () => `m${String(++msgCounter).padStart(2, "0")}`

interface ActorProc {
	name: string
	role: string
	session: AgentSession
	quota: Map<string, number> // (type) -> used, single task in spike
}

export class GraphRunner {
	private actors = new Map<string, ActorProc>()
	private log: EventLog
	/** resolves when the graph reaches a terminal state */
	readonly finished: Promise<{
		outcome: "lgtm" | "exhausted" | "failed"
		error?: string
	}>

	constructor(
		readonly runId: string,
		graphId: string,
		private readonly cwd: string,
	) {
		this.log = new EventLog(runId, graphId)
		this.finished = new Promise((resolve) => {
			this.resolveFinished = resolve
		})
	}
	private resolveFinished!: (r: {
		outcome: "lgtm" | "exhausted" | "failed"
		error?: string
	}) => void

	// ---------------- spawn (ticket 01 services path) ----------------

	private async spawnActor(
		roleName: string,
		actorName: string,
	): Promise<ActorProc> {
		const role = ROLES[roleName]
		const services = await createAgentSessionServices({
			cwd: this.cwd,
			resourceLoaderOptions: {
				noExtensions: true,
				systemPrompt: role.systemPrompt,
			},
		})
		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(this.cwd),
			// NB: the allowlist filters CUSTOM tools too (agent-session.js _refreshToolRegistry)
			// — emit must ride the allowlist or it silently never reaches the model.
			tools: [...role.tools, "emit"],
			customTools: [this.makeEmitTool(roleName, actorName)],
		})

		// thin the session event stream into schema-v1 actor events (ticket 05)
		const busy = new Set<string>()
		session.subscribe((ev) => {
			if (ev.type === "agent_start") {
				if (!busy.has(actorName)) {
					busy.add(actorName)
					this.log.emit({ type: "actor_busy", actor: actorName })
				}
			} else if (ev.type === "agent_settled") {
				busy.delete(actorName) // settles once per run incl. retries — agent_end can double-fire
				this.log.emit({ type: "actor_idle", actor: actorName })
				this.checkStall()
			} else if (ev.type === "tool_execution_start") {
				this.log.emit({
					type: "actor_tool",
					actor: actorName,
					tool: ev.toolName,
					phase: "start",
					detail: ev.toolName === "emit" ? ev.args?.type : undefined,
				})
			} else if (ev.type === "tool_execution_end") {
				this.log.emit({
					type: "actor_tool",
					actor: actorName,
					tool: ev.toolName,
					phase: "end",
					ok: !ev.isError,
				})
			}
		})

		this.log.emit({
			type: "actor_spawned",
			actor: actorName,
			role: roleName,
			task_id: null,
			session_id: session.sessionId,
			cwd: this.cwd,
		})
		return { name: actorName, role: roleName, session, quota: new Map() }
	}

	// ---------------- emit tool (ticket 02: refusal = in-turn error) ----------------

	private makeEmitTool(roleName: string, actorName: string) {
		return {
			name: "emit",
			label: "emit",
			description:
				"Emit a typed message onto the graph. This is the ONLY way to communicate or signal completion. After emitting, end your turn.",
			promptSnippet:
				"emit({type, payload}) — send a typed message onto the graph channel.",
			parameters: Type.Object({
				type: Type.String({
					description: `Message type. Allowed: ${ROLES[roleName].emits.map((d) => `"${d.type}"`).join(", ")}.`,
				}),
				payload: Type.String({
					description:
						"Short summary of the message content (a few sentences max).",
				}),
			}),
			execute: async (
				_id: string,
				params: { type: string; payload: string },
			) => {
				const decl = ROLES[roleName].emits.find((d) => d.type === params.type)
				if (!decl) {
					return {
						content: [
							{
								type: "text" as const,
								text: `ERROR: type "${params.type}" is not declared for role ${roleName}. Allowed: ${ROLES[roleName].emits.map((d) => d.type).join(", ")}.`,
							},
						],
						details: { refused: true },
					}
				}
				const used =
					(this.actors.get(actorName)?.quota.get(params.type) ?? 0) + 1
				if (decl.max_per_task !== undefined && used > decl.max_per_task) {
					const error = `"${params.type}" 已用完 ${decl.max_per_task} 次（任务 t1）。请停止重试：简要总结当前状态后结束你的回合。`
					this.log.emit({
						type: "emit_refused",
						actor: actorName,
						role: roleName,
						msg_type: params.type,
						task_id: "t1",
						reason: "quota_exhausted",
						quota: { max_per_task: decl.max_per_task, used: used - 1 },
						error,
					})
					// exhausted the loop's forward type → graph outcome
					this.settle(
						"exhausted",
						`${actorName} exhausted ${params.type} quota`,
					)
					return {
						content: [{ type: "text" as const, text: `ERROR: ${error}` }],
						details: { refused: true },
					}
				}
				this.actors.get(actorName)?.quota.set(params.type, used)
				const env: Envelope = {
					msg_id: nextMsgId(),
					type: params.type,
					task_id: "t1",
					payload: params.payload.slice(0, 200),
					sender: actorName,
					role: roleName,
				}
				this.log.emit({
					type: "message_emitted",
					msg_id: env.msg_id,
					msg_type: env.type,
					task_id: "t1",
					payload_preview: env.payload,
					actor: actorName,
					role: roleName,
					via: "emit",
				})
				// route after the tool returns, so the turn ends first (fire-and-forget)
				queueMicrotask(() => this.route(env))
				return {
					content: [
						{
							type: "text" as const,
							text: `emitted ${env.type} (${env.msg_id})`,
						},
					],
					details: { msg_id: env.msg_id },
				}
			},
		}
	}

	// ---------------- router (ticket 03: one channel max, quotas, lazy spawn) ----------------

	private findChannel(env: Envelope): ChannelDef | undefined {
		return CHANNELS.find((c) => c.from === env.role && c.when === env.type)
	}

	private async route(env: Envelope) {
		const channel = this.findChannel(env)
		if (!channel) {
			// e.g. task_started has no channel — acceptable in spike; log & drop
			this.log.emit({
				type: "message_routed",
				msg_id: env.msg_id,
				task_id: "t1",
				channel: "none",
				iteration: 0,
			})
			return
		}
		if (TERMINAL_TYPES.has(env.type)) {
			this.log.emit({
				type: "message_routed",
				msg_id: env.msg_id,
				task_id: "t1",
				channel: channel.id,
				iteration: 0,
			})
			this.log.emit({
				type: "task_done",
				task_id: "t1",
				via: "task_complete_type",
			})
			this.settle("lgtm")
			return
		}
		const iteration =
			(this.channelIters.get(channel.id) ?? 0) +
			(channel.id === "revise" ? 1 : 0)
		this.channelIters.set(channel.id, channel.id === "revise" ? iteration : 0)
		this.log.emit({
			type: "message_routed",
			msg_id: env.msg_id,
			task_id: "t1",
			channel: channel.id,
			iteration: channel.id === "revise" ? iteration : 0,
		})

		// lazy spawn on first routed message (ticket 03 R13)
		if (channel.to === "__runner__") return // shouldn't happen (terminal handled above)
		const actorName = `${channel.to}-for-t1`
		let proc = this.actors.get(actorName)
		if (!proc) {
			proc = await this.spawnActor(channel.to, actorName)
			this.actors.set(actorName, proc)
		}
		await this.deliver(proc, env, channel)
	}
	private channelIters = new Map<string, number>()

	private async deliver(proc: ActorProc, env: Envelope, _channel: ChannelDef) {
		const busy = proc.session.isStreaming
		this.inFlight++
		this.log.emit({
			type: "message_delivered",
			msg_id: env.msg_id,
			to: proc.name,
			delivery: busy ? "steered" : "triggered",
		})
		try {
			// triggerTurn: sendCustomMessage resolves AFTER the full turn — deliver
			// logging must precede it (spike lesson 1: event order = delivery order)
			await proc.session.sendCustomMessage(
				{
					customType: "graph_message",
					content: `[graph_message] type=${env.type} from=${env.sender}\npayload: ${env.payload}`,
					display: false,
					details: env,
				},
				{ triggerTurn: !busy, deliverAs: busy ? "steer" : undefined },
			)
		} finally {
			this.inFlight--
			this.checkStall()
		}
	}

	// ---------------- lifecycle ----------------

	private settled = false
	private inFlight = 0
	private stallTimer: ReturnType<typeof setTimeout> | null = null

	/** every actor idle, nothing in flight, nothing routed → the graph stalled. */
	private checkStall() {
		if (this.settled || this.inFlight > 0 || this.stallTimer) return
		this.stallTimer = setTimeout(() => {
			this.stallTimer = null
			const anyBusy = [...this.actors.values()].some(
				(a) => a.session.isStreaming,
			)
			if (!this.settled && !anyBusy && this.inFlight === 0) {
				this.settle(
					"failed",
					"graph stalled: an actor ended its turn without emit",
				)
			}
		}, 250)
	}

	private settle(outcome: "lgtm" | "exhausted" | "failed", error?: string) {
		if (this.settled) return
		this.settled = true
		if (outcome === "failed") {
			this.log.emit({ type: "graph_failed", error: error ?? "unknown" })
		} else {
			this.log.emit({ type: "graph_completed" })
		}
		for (const p of this.actors.values()) p.session.dispose()
		this.resolveFinished({ outcome, error })
	}

	async start(brief: string) {
		this.log.emit({
			type: "graph_started",
			workspace_mode: "shared",
			graph_file: "spike://review-graph",
		})
		this.log.emit({
			type: "task_created",
			task_id: "t1",
			by: "spike",
			summary: brief.slice(0, 60),
		})
		// kickoff: the runner plays coordinator — deliver task_assigned to coder
		const env: Envelope = {
			msg_id: nextMsgId(),
			type: "task_assigned",
			task_id: "t1",
			payload: brief,
			sender: "spike-runner",
			role: "__runner__",
		}
		this.log.emit({
			type: "message_emitted",
			msg_id: env.msg_id,
			msg_type: env.type,
			task_id: "t1",
			payload_preview: env.payload.slice(0, 200),
			actor: env.sender,
			role: env.role,
			via: "synthesized",
		})
		await this.route(env)
	}

	async fail(error: string) {
		this.settle("failed", error)
	}
}
