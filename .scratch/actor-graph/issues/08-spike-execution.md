# Ticket 08: Spike — does the execution model actually run with real sessions?

Status: resolved
Type: task (AFK, execution)
Parent map: [Actor-Graph map](../map.md)

## Question

Prove the actor-graph execution model end-to-end with **real headless LLM sessions**, ahead of the RFC (ticket 07) and the scaffolded extension — per user pivot (2026-08-22, "先做一个 POC 吧").

Spike scope (deliberately narrow — no YAML parser, no worktree/merge, no `/graph` command, no TUI widget):

1. Hardcoded review graph: **coder + critic** on one shared task in a generated demo repo; channels `review` (coder→critic, `pr_ready`) and `revise` (critic→coder, `revision`); `lgtm` = terminal type.
2. Runner: lazy `createAgentSession` spawns (services path per command-center wiring), per-role system prompts, `emit` customTool, channel router with `max_per_task` quotas (in-turn tool errors), delivery via `sendCustomMessage`, termination on `lgtm` or quota exhaustion.
3. Observability: schema-v1 events (from [05](05-event-schema-prototype.md)) appended to `runs/<run-id>/events.jsonl`, live single-line log, final dashboard frame rendered by replaying the log through the [prototype reducer](../prototype/dashboard.ts) — proving the schema + reducer work on real events, not just scripted ones.

Success: the loop converges — coder implements, critic reviews, at most one revision, `lgtm`, graph_completed — with a gap-free event log that replays to a correct dashboard frame. Findings (API corrections, prompt-adherence surprises, timing) feed tickets 07 (RFC) and the runner/fog sizing.

## Context

- Map pivot: the effort's Notes now record that execution work (this spike) precedes the RFC by user decision; wayfinder "plan, don't do" default is overridden for this ticket only.
- Reuses resolved decisions from 01 (services-path spawn), 02 (emit tool + envelope), 03 (quotas/loop), 05 (event schema). Shared mode per 04 (no worktree in spike).

## Answer

**The execution model runs.** Three real-LLM runs (default zai/glm-5.3), each to a clean terminal state, artifacts under `runs/run-spike-*` (gitignored):

| Run | Outcome | Proved |
| --- | --- | --- |
| `run-spike-092432` (37 events) | `lgtm` | zero-revision happy path: coder implements → pr_ready → critic lazy-spawn → review → lgtm → task_done |
| `run-spike-093035` (75 events) | `exhausted` | planted conflict → debate loop → revise iter 1→2→3 → 4th pr_ready **refused at quota 3/3** (in-turn error) → clean termination |
| `run-spike-093653` (64 events) | `lgtm` | the convergence story: brief-compliant PR → critic revision ("no JSDoc") → coder **fixes** (JSDoc + test file, tests run) → lgtm ("Clean…") → done |

All logs gap-free `seq`, replay through the prototype reducer to correct TASKS/ACTORS/MESSAGES views.

### Mechanics proven

Services-path spawn (per-role system prompt + tool allowlist + emit customTool) · lazy spawn on first routed message · channel routing incl. back-edge with iteration counters · quota refusal with in-turn error + `exhausted` terminal · `sendCustomMessage` delivery (triggered) · schema-v1 event log.

### SDK/LLM lessons (RFC inputs)

1. **`tools` allowlist filters `customTools` too** (`agent-session.js _refreshToolRegistry`: `isAllowedTool` applied to custom tools) — emit must ride the allowlist (`[...role.tools, "emit"]`) or the model never sees it. Silent failure.
2. **`promptSnippet` is dead under a replaced system prompt** — role prompts must name and *mandate* emit explicitly ("call emit as the LAST action; not calling it stalls the graph").
3. `sendCustomMessage({triggerTurn:true})` resolves **after the full turn** — log delivery events before the call.
4. `agent_end` + `agent_settled` both fire per turn — dedupe; `agent_settled` is the reliable idle signal.
5. Bun `spawnSync` with nonexistent cwd → misleading `ENOENT '/bin/sh'` (mkdir first).
6. LLMs hallucinate repo tooling (critic demanded a spec file "claimed in package.json") — minimal `package.json` in the demo repo grounds actors.
7. Stall is **detectable** (all idle + nothing in flight → turn ended without emit); spike fast-fails on it — v1's "no watchdog" decision stands, but the RFC should note the cheap detection.
8. `settle()` disposing mid-drain leaves final actor states as thinking/executing — RFC should decide graceful drain before dispose.
9. A planted **contradiction** produces a debate loop (quota saves it); an **omission** produces the fix loop — demo task design lesson for ticket 06's tier-2 script.

Code: [poc/graph.ts](../poc/graph.ts) (hardcoded graph), [poc/runner.ts](../poc/runner.ts) (runner seed), [poc/main.ts](../poc/main.ts) (scaffold + live tail + dashboard replay).
