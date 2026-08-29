# Map: Actor-Graph Extension (Generalized Graph Workflow for Pi)

Label: wayfinder:map

## Destination

A spec (`plans/actor-graph-rfc.md`) plus a minimal, functional PoC — an **independent extension in this repo** that parses a graph YAML and executes it as headless, intercom-addressed actor sessions — with observability rich enough that a dashboard (TUI progress view in the triggering session) can be built on the emitted events. Verified by `bun run verify` green.

## Notes

- **Domain**: Pi coding-agent extension; message-driven actor graph generalizing command-center's fixed Meta-Graph (Lead plan → work item → review/reject loop → merge).
- **Standing constraints (locked during charting, treat as non-negotiable)**:
  - Fully independent extension — **never modify command-center**; changes stay in this repo (see AGENTS.md).
  - Actor execution = **intercom + headless sessions** (option A from [routing options](routing-options.md)). Triggering session is never reused as an actor; it becomes the read-only progress view.
  - Graph definitions = YAML files in `~/.pi/graphs/`; built-in templates ship with the extension but are zero runtime dependency.
  - Routing v1 = **pure declarative channels**, with three pins: ① typed message envelope (emit contract), ② role `emits` declarations for static validation, ③ channel `max_iterations` termination for revision loops. The dispatch escape hatch (C-model) is post-v1.
  - Progress rendering = standardized events + custom TUI component (pattern exists in command-center's mission widget, but re-implemented, not shared).
- **Skills to consult**: grilling + domain-modeling for decision tickets; prototype skill for prototype tickets; pi-intercom skill for envelope/protocol work; tdd for later implementation slices.
- **Execution override (2026-08-22)**: user pivoted to a POC before the RFC — spike [ticket 08](issues/08-spike-execution.md) executed with real sessions and **converged** (3 clean-terminal runs); "plan, don't do" was overridden for that ticket only. Its 9 SDK/LLM lessons (allowlist filters customTools; promptSnippet dead under replaced system prompt; stall detectable; demo-task design) are RFC inputs for ticket 07.
- **Assets**: [handoff.md](handoff.md) (pre-map session decisions), [routing-options.md](routing-options.md) (routing model comparison that settled the A-vs-C decision).
- **Verify**: `bun run verify` (biome + tsc + bun test) from repo root.

## Decisions so far

<!-- one line per closed ticket: gist + link -->

- [How does an extension spawn and address headless Pi sessions?](issues/01-session-spawning-mechanics.md) — spawn actors in-process via `createAgentSession()` (or `pi --mode rpc --name` subprocesses), address them by Pi session name mirrored into intercom presence, observe via `session.subscribe` + pi-intercom extension channels; command-center's SessionRunner seam/normalizePiEvent are the patterns to re-implement.
- [How does the typed message envelope map onto intercom send/ask/reply?](issues/02-intercom-envelope-mapping.md) — in-process SDK sessions (intercom = observation plane, not bus); envelope = actor-declared `msg_id/type/task_id/payload` + coordinator-stamped `sender/iteration/channel`; emit is a customTool with refusal feedback; delivery via `sendCustomMessage` (verified transcript-persistent); `/graph steer` with autocomplete for live intervention; envelope physically lacks address fields — channels own "where"; type-level upstream/downstream view injected into actor prompts by default (`disable_graph_context` opt-out).
- [What is the YAML grammar for channels, and what can be statically validated?](issues/03-channel-grammar-validation.md) — final grammar in [research/03-channels-grammar-final.md](research/03-channels-grammar-final.md): explicit multicast (`to` string|array, ambiguity = load error), `create_task` tool factory (can_create_tasks gate) with planned-state registration + lazy session spawn, loop protection via per-type `max_per_task` quotas (emit errors in-turn, guiding LLM convergence) instead of max_iterations/watchdog, tools physically scoped to spawned sessions, validator rules + line-precise error UX.
- [How are shared state (blackboard) and per-task workspaces isolated?](issues/04-blackboard-workspace-isolation.md) — blackboard = runner-derived materialized view of message flow (no actor writes), persisted to `runs/<run-id>/blackboard.json`; workspace = integration-tree worktree architecture (task worktrees branch from integration state; `complete_task` owner-only tool atomically merges — success = done, conflict = in-loop error) or shared mode; lifecycle: abort retains all, resume rebuilds from disk (simple no-exactly-once), 60-day auto-GC + `/graph gc`, `/graph delete`.
- [What event stream suffices to render the graph dashboard?](issues/05-event-schema-prototype.md) — envelope `{v,seq,ts,run_id,graph_id}` (gap-free seq = resume cursor), 23 event types / 6 families; correlation by stable ids with **all views derived** (no blackboard events — it's a derived view); message flow stays stage-split (emitted→routed→delivered per recipient); consumption = in-process reducer + append-only `runs/<run-id>/events.jsonl` + pi-intercom extension channel `actor-graph/v1`; prototype + demo in [prototype/](prototype/), decisions grilled and applied there.
- [Which example graph proves the PoC, and what is acceptance?](issues/06-example-graph-acceptance.md) — canonical example = review-pipeline (worktree, quotas, complete_task merge); ships with pair.yaml (driver↔navigator, shared, no quotas, task_complete_type); two-tier bar: Tier 1 automated FakeSessionRunner harness in `bun run verify` (8 items incl. abort/resume replay + gc), Tier 2 = one real-LLM demo run on a generated throwaway repo (`bun run demo:graph` story); not proven: LLM convergence quality, cross-process fan-out, coordinator crash recovery, GC timing.
- [Spike — does the execution model actually run with real sessions?](issues/08-spike-execution.md) — **YES**: 3 real-LLM runs to clean terminals — happy-path lgtm (37 events), planted-conflict debate loop → quota refusal at 3/3 → exhausted (75 events), omission-fix loop → lgtm (64 events); all mechanics proven (lazy spawn, back-edge routing w/ iteration counters, quota refusal in-turn, sendCustomMessage delivery, gap-free schema-v1 events replaying via prototype reducer); 9 SDK/LLM lessons recorded in the ticket (allowlist filters customTools; promptSnippet dead under replaced system prompt; turn-end-without-emit stall detectable; …).
- [Scaffold the actor-graph extension](issues/09-scaffold-registration.md) — **DONE, verify green**: full RFC §14 layout (11 src stubs with real grammar/seam types, /graph stub commands, widget placeholder, 15 smoke tests), registered in root package.json, both templates + 5 prompts shipped (S2 MANDATORY-emit test-guarded), `demo:graph` script; **2 template deviations from RFC Appendix A surfaced for ticket 13** (R1: lgtm needed an approve channel critic→coder; R5: pair conclude now multicasts to coordinator+runner); pre-existing verify-red drift fixed in passing (mini-task format + two type repairs, tsconfig comments).
- [Write the actor-graph RFC consolidating the resolved decisions](issues/07-spec-rfc.md) — RFC authored at `plans/actor-graph-rfc.md` (15 sections + template appendix; verify green): architecture/grammar/validator/envelope/routing/workspace/events/acceptance consolidated + 9 spike lessons made normative; 2 delegated micro-decisions made (stall = fast-fail, graceful drain); **7 gaps surfaced as OQ1–OQ7 with recommendations, not decided** (runner pseudo-role, kickoff delivery, multi-pipeline create_task, completion semantics, blackboard reads, runs-dir conflict); fog graduated into sized tickets 09–13.

## Not yet specified

<!-- in-scope fog; graduates as the frontier advances -->

<!-- all fog graduated by ticket 07: scaffold→09, runner→10, TUI→11, tests→12; OQ gaps→13. New execution fog may gather as 09–13 resolve. -->

## Out of scope

<!-- work ruled beyond the destination; never graduates -->

- **Multi-graph parallelism** — running several graphs concurrently; deferred by explicit user decision.
- **Dispatch escape hatch (C-model routing)** — dynamic per-message addressing via a runner-provided `dispatch` tool; deliberately post-v1, add without breaking the channels schema.
- **Modifying command-center** — this effort must not touch the command-center extension.
- **LLM-generated dynamic graphs** — graphs are authored YAML, not generated on the fly from conversation intent.
