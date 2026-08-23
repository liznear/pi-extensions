/**
 * PROTOTYPE (spike) — wayfinder ticket 08: entry point.
 *
 * Scaffolds a throwaway demo repo (git init + README), runs the hardcoded
 * review graph with REAL headless LLM sessions, tails the event log live,
 * and renders the final dashboard frame by replaying events.jsonl through
 * the prototype reducer — the same reducer the real TUI will use.
 *
 * Run: bun .scratch/actor-graph/poc/main.ts [--keep]
 */

import { execSync } from "node:child_process"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { type DashboardState, fold, initState } from "../prototype/dashboard.ts"
import type { GraphEvent } from "../prototype/events.ts"
import { RUN_ID, TASK_BRIEF } from "./graph.ts"
import { GraphRunner } from "./runner.ts"

const ROOT = process.cwd()
const DEMO = join(ROOT, "runs", "demo-repo")

// ---- scaffold throwaway demo repo ----
// NB: spawnSync reports ENOENT on /bin/sh (misleadingly) if cwd doesn't exist
rmSync(DEMO, { recursive: true, force: true })
mkdirSync(DEMO, { recursive: true })
execSync("git init -q .", { cwd: DEMO })
writeFileSync(
	join(DEMO, "README.md"),
	"# demo repo\n\nSpike target for the actor-graph review pipeline.\n",
)
// package.json makes the repo legible to LLM actors ("tests" resolves, no phantom spec)
writeFileSync(
	join(DEMO, "package.json"),
	JSON.stringify(
		{
			name: "demo-repo",
			private: true,
			type: "module",
			scripts: { test: "bun test" },
		},
		null,
		2,
	) + "\n",
)
execSync("git add -A && git commit -qm init", { cwd: DEMO })

console.log(`▶ spike run ${RUN_ID}`)
console.log(`▶ demo repo: ${DEMO}\n`)

// ---- run the graph with a live tail ----
const runner = new GraphRunner(RUN_ID, "review-graph", DEMO)
const logPath = join(ROOT, "runs", RUN_ID, "events.jsonl")

let lastSize = 0
const tail = () => {
	const text = readFileSync(logPath, "utf8")
	const lines = text.split("\n").filter(Boolean)
	for (let i = lastSize; i < lines.length; i++) {
		let e: GraphEvent
		try {
			e = JSON.parse(lines[i]) as GraphEvent
		} catch {
			continue // partial line while appendFileSync is mid-write
		}
		const dim = "\x1b[2m"
		const reset = "\x1b[0m"
		const detail =
			e.type === "message_emitted"
				? `${e.actor} ⊙ ${e.msg_type} "${e.payload_preview.slice(0, 60)}"`
				: e.type === "message_routed"
					? `${e.msg_id} ⇢ ${e.channel} (iter ${e.iteration})`
					: e.type === "message_delivered"
						? `${e.msg_id} → ${e.to} (${e.delivery})`
						: e.type === "emit_refused"
							? `${e.actor} ${e.msg_type} REFUSED [${e.quota?.used}/${e.quota?.max_per_task}]`
							: e.type === "actor_tool"
								? `${e.actor} ${e.tool} ${e.phase}`
								: e.type === "actor_busy"
									? `${e.actor} ● busy`
									: e.type === "actor_idle"
										? `${e.actor} · idle`
										: e.type === "task_done"
											? `task DONE`
											: e.type
		console.log(`${dim}seq ${String(e.seq).padStart(3)}${reset} ${detail}`)
	}
	lastSize = lines.length
}

const tailTimer = setInterval(tail, 400)

// safety timeout: spike must not hang forever
const timeout = setTimeout(
	() => runner.fail("spike timeout (10 min)"),
	10 * 60_000,
)

process.on("unhandledRejection", (err) => {
	console.error("\n✖ unhandled rejection:", err)
	runner.fail(`unhandled rejection: ${err}`)
})

try {
	// kickoff happens inside start(); the runner plays coordinator
	await runner.start(TASK_BRIEF)
	const result = await runner.finished
	clearTimeout(timeout)
	tail()
	clearInterval(tailTimer)

	// ---- final dashboard frame: replay events.jsonl through the prototype reducer ----
	const events = readFileSync(logPath, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as GraphEvent)
	const s: DashboardState = initState(RUN_ID, "review-graph")
	for (const e of events) fold(s, e)

	console.log(
		`\n${"\x1b[2m"}──────────────── dashboard (replayed from events.jsonl) ────────────────${"\x1b[0m"}`,
	)
	for (const t of Object.values(s.tasks)) {
		const iters = Object.entries(t.iterations)
			.filter(([, { max }]) => max !== undefined)
			.map(([ch, { n, max }]) => `${ch} ${n}/${max}`)
			.join(" · ")
		console.log(`  TASK ${t.task_id} [${t.status}] "${t.summary}" ${iters}`)
	}
	for (const a of Object.values(s.actors)) {
		console.log(`  ACTOR ${a.actor.padEnd(16)} ${a.role.padEnd(7)} ${a.state}`)
	}
	const msgs = s.messages.map(
		(m) =>
			`${m.msg_id} ${m.msg_type} ${m.from} → ${m.channel ?? "?"} → ${m.delivered_to.map((d) => d.actor).join(",") || "…"}`,
	)
	console.log(`  MESSAGES\n    ${msgs.join("\n    ")}`)
	console.log(
		`\n▶ outcome: ${result.outcome}${result.error ? ` — ${result.error}` : ""}`,
	)
	console.log(
		`▶ event log: ${logPath} (${events.length} events, seq gap-free: ${events.every((e, i) => e.seq === i + 1)})`,
	)
	console.log(`▶ demo repo kept at ${DEMO} (runs/ is disposable)`)
	process.exit(result.outcome === "failed" ? 1 : 0)
} catch (err) {
	console.error("\n✖ spike crashed:", err)
	clearInterval(tailTimer)
	process.exit(1)
}
