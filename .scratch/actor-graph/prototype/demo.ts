/**
 * PROTOTYPE (throwaway) — wayfinder ticket 05: dashboard demo driver.
 *
 * Scripted event stream for a 2-task review-pipeline run (revision loop,
 * quota refusal, merge conflict, human steer), replayed key-by-key into the
 * dashboard reducer. The TUI shell here is throwaway; events.ts and
 * dashboard.ts are the artifacts under review.
 *
 * Run:   bun .scratch/actor-graph/prototype/demo.ts            (interactive)
 *        bun .scratch/actor-graph/prototype/demo.ts --auto 150 (non-interactive)
 */

import { type DashboardState, fold, initState } from "./dashboard"
import type { GraphEvent } from "./events"

// ------------------------------------------------------------------
// Scenario builder — stamps seq/ts like the runner would
// ------------------------------------------------------------------

const RUN = "run-demo"
const GRAPH = "review-pipeline"

function buildScenario(): GraphEvent[] {
	const out: GraphEvent[] = []
	let seq = 0
	let ts = Date.now() - 600_000
	const base = { v: 1 as const, run_id: RUN, graph_id: GRAPH }
	const push = <T extends Omit<GraphEvent, keyof typeof base | "seq" | "ts">>(
		body: T,
	) => {
		seq += 1
		ts += 250
		// biome-ignore lint/suspicious/noExplicitAny: throwaway demo builder
		out.push({ ...base, seq, ts, ...(body as any) })
	}

	push({
		type: "graph_started",
		workspace_mode: "worktree",
		graph_file: "~/.pi/graphs/review-pipeline.yaml",
	})
	push({
		type: "actor_spawned",
		actor: "coordinator",
		role: "coordinator",
		task_id: null,
		session_id: "sess-coord",
		cwd: "~/repo",
	})
	push({ type: "actor_busy", actor: "coordinator" })
	push({
		type: "actor_tool",
		actor: "coordinator",
		tool: "create_task",
		phase: "start",
		detail: "t1",
	})
	push({
		type: "task_created",
		task_id: "t1",
		by: "coordinator",
		summary: "add user login endpoint",
	})
	push({
		type: "actor_planned",
		actor: "coder-for-t1",
		role: "coder",
		task_id: "t1",
	})
	push({
		type: "actor_planned",
		actor: "critic-for-t1",
		role: "critic",
		task_id: "t1",
	})
	push({
		type: "message_emitted",
		msg_id: "m01",
		msg_type: "task_assigned",
		task_id: "t1",
		payload_preview: "implement POST /login; see runs/run-demo/t1/brief.md",
		actor: "coordinator",
		role: "coordinator",
		via: "emit",
	})
	push({
		type: "message_routed",
		msg_id: "m01",
		task_id: "t1",
		channel: "assign",
		iteration: 0,
	})
	push({
		type: "actor_tool",
		actor: "coordinator",
		tool: "create_task",
		phase: "end",
		ok: true,
		detail: "t1 → planned [coder, critic]",
	})
	push({ type: "actor_idle", actor: "coordinator" })
	// lazy spawn: first routed message for <coder, t1> spawns the session
	push({
		type: "actor_spawned",
		actor: "coder-for-t1",
		role: "coder",
		task_id: "t1",
		session_id: "sess-c1",
		cwd: "runs/run-demo/t1",
	})
	push({
		type: "message_delivered",
		msg_id: "m01",
		to: "coder-for-t1",
		delivery: "triggered",
	})
	push({ type: "actor_busy", actor: "coder-for-t1" })
	push({ type: "worktree_created", task_id: "t1", path: "runs/run-demo/t1" })
	push({
		type: "actor_tool",
		actor: "coder-for-t1",
		tool: "bash",
		phase: "start",
		detail: "npm test",
	})
	push({
		type: "actor_tool",
		actor: "coder-for-t1",
		tool: "bash",
		phase: "end",
		ok: true,
	})
	push({
		type: "message_emitted",
		msg_id: "m02",
		msg_type: "pr_ready",
		task_id: "t1",
		payload_preview: "diff at runs/run-demo/t1/changes.patch",
		actor: "coder-for-t1",
		role: "coder",
		via: "emit",
	})
	push({
		type: "message_routed",
		msg_id: "m02",
		task_id: "t1",
		channel: "review",
		iteration: 1,
		iteration_max: 3,
	})
	push({
		type: "actor_spawned",
		actor: "critic-for-t1",
		role: "critic",
		task_id: "t1",
		session_id: "sess-r1",
		cwd: "runs/run-demo/t1",
	})
	push({
		type: "message_delivered",
		msg_id: "m02",
		to: "critic-for-t1",
		delivery: "triggered",
	})
	push({ type: "actor_busy", actor: "critic-for-t1" })
	push({
		type: "message_emitted",
		msg_id: "m03",
		msg_type: "revision",
		task_id: "t1",
		payload_preview: "handle token expiry; tests for 401",
		actor: "critic-for-t1",
		role: "critic",
		via: "emit",
	})
	push({
		type: "message_routed",
		msg_id: "m03",
		task_id: "t1",
		channel: "revise",
		iteration: 1,
		iteration_max: 3,
	})
	push({
		type: "message_delivered",
		msg_id: "m03",
		to: "coder-for-t1",
		delivery: "steered",
	})
	push({
		type: "actor_tool",
		actor: "coder-for-t1",
		tool: "read",
		phase: "start",
		detail: "src/auth/login.ts",
	})
	push({
		type: "actor_tool",
		actor: "coder-for-t1",
		tool: "read",
		phase: "end",
		ok: true,
	})

	// task 2 spins up in parallel (coordinator singleton)
	push({ type: "actor_busy", actor: "coordinator" })
	push({
		type: "actor_tool",
		actor: "coordinator",
		tool: "create_task",
		phase: "start",
		detail: "t2",
	})
	push({
		type: "task_created",
		task_id: "t2",
		by: "coordinator",
		summary: "add rate limiter middleware",
	})
	push({
		type: "actor_planned",
		actor: "coder-for-t2",
		role: "coder",
		task_id: "t2",
	})
	push({
		type: "actor_planned",
		actor: "critic-for-t2",
		role: "critic",
		task_id: "t2",
	})
	push({
		type: "message_emitted",
		msg_id: "m04",
		msg_type: "task_assigned",
		task_id: "t2",
		payload_preview:
			"implement sliding-window limiter; see runs/run-demo/t2/brief.md",
		actor: "coordinator",
		role: "coordinator",
		via: "emit",
	})
	push({
		type: "message_routed",
		msg_id: "m04",
		task_id: "t2",
		channel: "assign",
		iteration: 0,
	})
	push({
		type: "actor_tool",
		actor: "coordinator",
		tool: "create_task",
		phase: "end",
		ok: true,
		detail: "t2 → planned [coder, critic]",
	})
	push({ type: "actor_idle", actor: "coordinator" })
	push({
		type: "actor_spawned",
		actor: "coder-for-t2",
		role: "coder",
		task_id: "t2",
		session_id: "sess-c2",
		cwd: "runs/run-demo/t2",
	})
	push({
		type: "message_delivered",
		msg_id: "m04",
		to: "coder-for-t2",
		delivery: "triggered",
	})
	push({ type: "actor_busy", actor: "coder-for-t2" })
	push({ type: "worktree_created", task_id: "t2", path: "runs/run-demo/t2" })

	// task 1 second round → lgtm
	push({
		type: "message_emitted",
		msg_id: "m05",
		msg_type: "pr_ready",
		task_id: "t1",
		payload_preview:
			"token expiry handled; diff at runs/run-demo/t1/changes.patch",
		actor: "coder-for-t1",
		role: "coder",
		via: "emit",
	})
	push({
		type: "message_routed",
		msg_id: "m05",
		task_id: "t1",
		channel: "review",
		iteration: 2,
		iteration_max: 3,
	})
	push({
		type: "message_delivered",
		msg_id: "m05",
		to: "critic-for-t1",
		delivery: "steered",
	})
	push({ type: "actor_idle", actor: "critic-for-t1" })
	push({ type: "actor_busy", actor: "critic-for-t1" })
	push({
		type: "message_emitted",
		msg_id: "m06",
		msg_type: "lgtm",
		task_id: "t1",
		payload_preview: "ship it",
		actor: "critic-for-t1",
		role: "critic",
		via: "emit",
	})
	push({
		type: "message_routed",
		msg_id: "m06",
		task_id: "t1",
		channel: "approve",
		iteration: 0,
	})
	push({
		type: "message_delivered",
		msg_id: "m06",
		to: "coder-for-t1",
		delivery: "triggered",
	})
	push({ type: "actor_idle", actor: "critic-for-t1" })

	// t1 complete_task → conflict (t2 landed first in this telling? no — t2 hasn't merged;
	// simulate integration drift via an earlier external merge)
	push({
		type: "actor_tool",
		actor: "coder-for-t1",
		tool: "complete_task",
		phase: "start",
	})
	push({ type: "merge_attempted", task_id: "t1", actor: "coder-for-t1" })
	push({
		type: "merge_conflicted",
		task_id: "t1",
		actor: "coder-for-t1",
		files: ["src/auth/login.ts"],
		error: "integration has moved; resolve and complete again",
		duration_ms: 6100,
	})
	push({
		type: "actor_tool",
		actor: "coder-for-t1",
		tool: "complete_task",
		phase: "end",
		ok: false,
		detail: "conflict on 1 file",
	})

	// human intervenes on t2's coder mid-run
	push({
		type: "steer_sent",
		actor: "coder-for-t2",
		text_preview: "watch the shared throttle config — don't hardcode limits",
	})
	push({
		type: "actor_tool",
		actor: "coder-for-t2",
		tool: "bash",
		phase: "start",
		detail: "npm run bench",
	})

	// t1 resolves conflict, merges
	push({
		type: "actor_tool",
		actor: "coder-for-t1",
		tool: "complete_task",
		phase: "start",
	})
	push({ type: "merge_attempted", task_id: "t1", actor: "coder-for-t1" })
	push({
		type: "merge_succeeded",
		task_id: "t1",
		actor: "coder-for-t1",
		commit: "a1b2c3d4e5f6",
		duration_ms: 4200,
	})
	push({
		type: "task_done",
		task_id: "t1",
		via: "complete_task",
		msg_id: "m07",
	})
	push({
		type: "message_emitted",
		msg_id: "m07",
		msg_type: "task_done",
		task_id: "t1",
		payload_preview: "",
		actor: "runner",
		role: "runner",
		via: "synthesized",
	})
	push({ type: "message_routed", msg_id: "m07", channel: "done", iteration: 0 })
	push({
		type: "message_delivered",
		msg_id: "m07",
		to: "coordinator",
		delivery: "steered",
	})
	push({ type: "worktree_deleted", task_id: "t1", path: "runs/run-demo/t1" })
	push({ type: "actor_idle", actor: "coder-for-t1" })
	push({ type: "actor_exited", actor: "coder-for-t1", reason: "disposed" })
	push({ type: "actor_exited", actor: "critic-for-t1", reason: "disposed" })

	// t2 rides the full quota: 3 revisions, 4th refused → lgtm
	push({
		type: "actor_tool",
		actor: "coder-for-t2",
		tool: "bash",
		phase: "end",
		ok: true,
	})
	push({
		type: "message_emitted",
		msg_id: "m08",
		msg_type: "pr_ready",
		task_id: "t2",
		payload_preview: "diff at runs/run-demo/t2/changes.patch",
		actor: "coder-for-t2",
		role: "coder",
		via: "emit",
	})
	push({
		type: "message_routed",
		msg_id: "m08",
		task_id: "t2",
		channel: "review",
		iteration: 1,
		iteration_max: 3,
	})
	push({
		type: "actor_spawned",
		actor: "critic-for-t2",
		role: "critic",
		task_id: "t2",
		session_id: "sess-r2",
		cwd: "runs/run-demo/t2",
	})
	push({
		type: "message_delivered",
		msg_id: "m08",
		to: "critic-for-t2",
		delivery: "triggered",
	})
	push({ type: "actor_busy", actor: "critic-for-t2" })
	push({
		type: "message_emitted",
		msg_id: "m09",
		msg_type: "revision",
		task_id: "t2",
		payload_preview: "extract window size to config",
		actor: "critic-for-t2",
		role: "critic",
		via: "emit",
	})
	push({
		type: "message_routed",
		msg_id: "m09",
		task_id: "t2",
		channel: "revise",
		iteration: 1,
		iteration_max: 3,
	})
	push({
		type: "message_delivered",
		msg_id: "m09",
		to: "coder-for-t2",
		delivery: "steered",
	})
	push({
		type: "message_emitted",
		msg_id: "m10",
		msg_type: "pr_ready",
		task_id: "t2",
		payload_preview: "config-extracted; diff at runs/run-demo/t2/changes.patch",
		actor: "coder-for-t2",
		role: "coder",
		via: "emit",
	})
	push({
		type: "message_routed",
		msg_id: "m10",
		task_id: "t2",
		channel: "review",
		iteration: 2,
		iteration_max: 3,
	})
	push({
		type: "message_delivered",
		msg_id: "m10",
		to: "critic-for-t2",
		delivery: "steered",
	})
	push({
		type: "message_emitted",
		msg_id: "m11",
		msg_type: "revision",
		task_id: "t2",
		payload_preview: "bench numbers in PR summary",
		actor: "critic-for-t2",
		role: "critic",
		via: "emit",
	})
	push({
		type: "message_routed",
		msg_id: "m11",
		task_id: "t2",
		channel: "revise",
		iteration: 2,
		iteration_max: 3,
	})
	push({
		type: "message_delivered",
		msg_id: "m11",
		to: "coder-for-t2",
		delivery: "steered",
	})
	push({
		type: "message_emitted",
		msg_id: "m12",
		msg_type: "pr_ready",
		task_id: "t2",
		payload_preview: "bench added; diff at runs/run-demo/t2/changes.patch",
		actor: "coder-for-t2",
		role: "coder",
		via: "emit",
	})
	push({
		type: "message_routed",
		msg_id: "m12",
		task_id: "t2",
		channel: "review",
		iteration: 3,
		iteration_max: 3,
	})
	push({
		type: "message_delivered",
		msg_id: "m12",
		to: "critic-for-t2",
		delivery: "steered",
	})
	push({
		type: "message_emitted",
		msg_id: "m13",
		msg_type: "revision",
		task_id: "t2",
		payload_preview: "one more: retry header",
		actor: "critic-for-t2",
		role: "critic",
		via: "emit",
	})
	push({
		type: "message_routed",
		msg_id: "m13",
		task_id: "t2",
		channel: "revise",
		iteration: 3,
		iteration_max: 3,
	})
	push({
		type: "message_delivered",
		msg_id: "m13",
		to: "coder-for-t2",
		delivery: "steered",
	})
	push({
		type: "message_emitted",
		msg_id: "m14",
		msg_type: "pr_ready",
		task_id: "t2",
		payload_preview: "retry header; diff at runs/run-demo/t2/changes.patch",
		actor: "coder-for-t2",
		role: "coder",
		via: "emit",
	})
	// the 4th pr_ready is refused at the emit tool — no message ever exists:
	// rewind the emitted event; the refusal is the only observable trace
	out.pop()
	out.pop()
	seq -= 1
	push({
		type: "emit_refused",
		actor: "coder-for-t2",
		role: "coder",
		msg_type: "pr_ready",
		task_id: "t2",
		reason: "quota_exhausted",
		quota: { max_per_task: 3, used: 3 },
		error: "pr_ready 已用完 3 次 (t2)。请等待 revision 或总结现状。",
	})

	push({ type: "actor_busy", actor: "critic-for-t2" })
	push({
		type: "message_emitted",
		msg_id: "m15",
		msg_type: "lgtm",
		task_id: "t2",
		payload_preview: "good enough for middleware v1",
		actor: "critic-for-t2",
		role: "critic",
		via: "emit",
	})
	push({
		type: "message_routed",
		msg_id: "m15",
		task_id: "t2",
		channel: "approve",
		iteration: 0,
	})
	push({
		type: "message_delivered",
		msg_id: "m15",
		to: "coder-for-t2",
		delivery: "steered",
	})
	push({
		type: "actor_tool",
		actor: "coder-for-t2",
		tool: "complete_task",
		phase: "start",
	})
	push({ type: "merge_attempted", task_id: "t2", actor: "coder-for-t2" })
	push({
		type: "merge_succeeded",
		task_id: "t2",
		actor: "coder-for-t2",
		commit: "9f8e7d6c5b4a",
		duration_ms: 3100,
	})
	push({
		type: "task_done",
		task_id: "t2",
		via: "complete_task",
		msg_id: "m16",
	})
	push({
		type: "message_emitted",
		msg_id: "m16",
		msg_type: "task_done",
		task_id: "t2",
		payload_preview: "",
		actor: "runner",
		role: "runner",
		via: "synthesized",
	})
	push({ type: "message_routed", msg_id: "m16", channel: "done", iteration: 0 })
	push({
		type: "message_delivered",
		msg_id: "m16",
		to: "coordinator",
		delivery: "steered",
	})
	push({ type: "worktree_deleted", task_id: "t2", path: "runs/run-demo/t2" })
	push({ type: "actor_idle", actor: "coder-for-t2" })
	push({ type: "actor_exited", actor: "coder-for-t2", reason: "disposed" })
	push({ type: "actor_exited", actor: "critic-for-t2", reason: "disposed" })
	push({ type: "actor_idle", actor: "coordinator" })
	push({ type: "graph_completed" })

	return out
}

// ------------------------------------------------------------------
// TUI shell — throwaway; full-frame re-render every action
// ------------------------------------------------------------------

const B = "\x1b[1m"
const D = "\x1b[2m"
const R = "\x1b[0m"
const RED = "\x1b[31m"
const GRN = "\x1b[32m"
const YEL = "\x1b[33m"
const CYA = "\x1b[36m"

const STATE_GLYPH: Record<string, string> = {
	planned: `${D}○ planned${R}`,
	thinking: `${YEL}● thinking${R}`,
	executing: `${CYA}◆ executing${R}`,
	idle: `${GRN}· idle${R}`,
	exited: `${D}✕ exited${R}`,
}

function hhmmss(ts: number): string {
	return new Date(ts).toLocaleTimeString("en-GB", { hour12: false })
}

function render(
	s: DashboardState,
	events: GraphEvent[],
	cursor: number,
): string {
	const w = 100
	const line = (c = "─") => D + c.repeat(w) + R
	const out: string[] = []

	const statusColor =
		s.run.status === "running" ? YEL : s.run.status === "completed" ? GRN : RED
	out.push(
		`${B}actor-graph PROTOTYPE${R} ${D}— dashboard replay (throwaway, ticket 05)${R} ${D}frame ${cursor}/${events.length}${R}`,
	)
	out.push(line())
	out.push(
		` ${B}${s.run.graph_id}${R} · ${s.run.run_id} · ${statusColor}${B}${s.run.status.toUpperCase()}${R} ${D}${s.run.workspace_mode ? `· ${s.run.workspace_mode} mode ` : ""}${s.run.started_at ? `· started ${hhmmss(s.run.started_at)}` : ""} · seq ${s.last_seq}${R}`,
	)
	out.push(` ${B}TASKS${R}`)
	for (const t of Object.values(s.tasks)) {
		// quota-bearing loop channels only — forward channels (assign/done) carry no
		// iteration semantics, showing them is noise (settled 2026-08-22 review)
		const quotaChannels: string[] = []
		for (const [ch, { n, max }] of Object.entries(t.iterations)) {
			if (max !== undefined) quotaChannels.push(`${ch} ${n}/${max}`)
		}
		const iters = quotaChannels.join(" · ")
		const merge =
			t.merge?.state === "conflict"
				? ` ${RED}merge CONFLICT (${t.merge.files?.length ?? 0} files)${R}`
				: t.merge?.commit
					? ` ${GRN}merged @${t.merge.commit.slice(0, 7)}${R}`
					: ""
		const st =
			t.status === "done"
				? GRN
				: t.status === "failed" || t.merge?.state === "conflict"
					? RED
					: YEL
		out.push(
			`  ${st}${B}${t.task_id}${R} ${st}${t.status.padEnd(11)}${R} ${t.summary}${merge}${iters ? `   ${D}[${iters}]${R}` : ""}`,
		)
	}
	out.push(` ${B}ACTORS${R}`)
	for (const a of Object.values(s.actors)) {
		const scope = a.task_id ? `[${a.task_id}]` : `${D}singleton${R}`
		const tool = a.last_tool ? `  ${D}${a.last_tool}${R}` : ""
		out.push(
			`  ${a.actor.padEnd(18)} ${scope.padEnd(10)} ${STATE_GLYPH[a.state] ?? a.state}${tool}`,
		)
	}
	out.push(
		` ${B}MESSAGES${R} ${D}(latest first — correlation: emitted → routed → delivered)${R}`,
	)
	for (const m of [...s.messages].reverse().slice(0, 6)) {
		const route = m.channel
			? `${m.channel}${m.iteration ? ` ${m.iteration}` : ""}`
			: "?"
		const dest =
			m.delivered_to.length > 0
				? m.delivered_to
						.map(
							(d) =>
								`${d.actor} ${GRN}✓${R}${D}${d.delivery === "steered" ? "⇢steer" : ""}${R}`,
						)
						.join(", ")
				: `${YEL}…${R}`
		out.push(
			`  ${D}${hhmmss(m.emitted_at)}${R} ${m.msg_id} ${B}${m.msg_type.padEnd(13)}${R} ${m.from.padEnd(15)} → ${CYA}${route.padEnd(12)}${R}→ ${dest}`,
		)
	}
	out.push(` ${B}FLOW${R} ${D}(tail)${R}`)
	for (const f of s.flow.slice(-5)) {
		const color =
			f.kind === "refuse"
				? RED
				: f.kind === "merge"
					? CYA
					: f.kind === "steer"
						? YEL
						: f.kind === "task"
							? GRN
							: D
		out.push(`  ${D}${String(f.seq).padStart(3)}${R} ${color}${f.text}${R}`)
	}
	out.push(line())
	out.push(
		` ${B}[n]${R} ${D}next event${R}   ${B}[p]${R} ${D}prev${R}   ${B}[a]${R} ${D}autoplay${R}   ${B}[r]${R} ${D}restart${R}   ${B}[q]${R} ${D}quit${R}`,
	)
	return out.join("\n")
}

function stateAt(events: GraphEvent[], n: number): DashboardState {
	const s = initState(RUN, GRAPH)
	for (const e of events.slice(0, n)) fold(s, e)
	return s
}

// ---- main loop ----

const autoIdx = process.argv.indexOf("--auto")
const autoMs = autoIdx >= 0 ? Number(process.argv[autoIdx + 1] ?? 200) : 0
const events = buildScenario()
let cursor = 1

function frame() {
	process.stdout.write(
		`\x1b[2J\x1b[H\x1b[?25l${render(stateAt(events, cursor), events, cursor)}\n`,
	)
}

if (autoMs > 0) {
	// non-interactive verification path: play through, print final frame
	while (cursor < events.length) {
		cursor += 1
	}
	process.stdout.write(
		`\x1b[2J\x1b[H${render(stateAt(events, cursor), events, cursor)}\n`,
	)
	process.stdout.write(`\x1b[?25h\nreplayed ${events.length} events OK\n`)
	process.exit(0)
}

process.stdin.setRawMode(true)
process.stdin.resume()
frame()

let timer: ReturnType<typeof setInterval> | null = null
const stopAuto = () => {
	if (timer) clearInterval(timer)
	timer = null
}
process.stdin.on("data", (buf: Buffer) => {
	const k = buf.toString()
	if (k === "q" || k === "\x03") {
		stopAuto()
		process.stdout.write("\x1b[?25h\n")
		process.exit(0)
	}
	if (k === "n" && cursor < events.length) cursor += 1
	else if (k === "p" && cursor > 1) cursor -= 1
	else if (k === "r") {
		cursor = 1
		stopAuto()
	} else if (k === "a") {
		if (timer) {
			stopAuto()
		} else {
			timer = setInterval(() => {
				if (cursor < events.length) {
					cursor += 1
					frame()
				} else stopAuto()
			}, 300)
		}
	}
	frame()
})
