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
- **Assets**: [handoff.md](handoff.md) (pre-map session decisions), [routing-options.md](routing-options.md) (routing model comparison that settled the A-vs-C decision).
- **Verify**: `bun run verify` (biome + tsc + bun test) from repo root.

## Decisions so far

<!-- one line per closed ticket: gist + link -->

- [How does an extension spawn and address headless Pi sessions?](issues/01-session-spawning-mechanics.md) — spawn actors in-process via `createAgentSession()` (or `pi --mode rpc --name` subprocesses), address them by Pi session name mirrored into intercom presence, observe via `session.subscribe` + pi-intercom extension channels; command-center's SessionRunner seam/normalizePiEvent are the patterns to re-implement.
- [How does the typed message envelope map onto intercom send/ask/reply?](issues/02-intercom-envelope-mapping.md) — in-process SDK sessions (intercom = observation plane, not bus); envelope = actor-declared `msg_id/type/task_id/payload` + coordinator-stamped `sender/iteration/channel`; emit is a customTool with refusal feedback; delivery via `sendCustomMessage` (verified transcript-persistent); `/graph steer` with autocomplete for live intervention; envelope physically lacks address fields — channels own "where"; type-level upstream/downstream view injected into actor prompts by default (`disable_graph_context` opt-out).
- [What is the YAML grammar for channels, and what can be statically validated?](issues/03-channel-grammar-validation.md) — final grammar in [research/03-channels-grammar-final.md](research/03-channels-grammar-final.md): explicit multicast (`to` string|array, ambiguity = load error), `create_task` tool factory (can_create_tasks gate) with planned-state registration + lazy session spawn, loop protection via per-type `max_per_task` quotas (emit errors in-turn, guiding LLM convergence) instead of max_iterations/watchdog, tools physically scoped to spawned sessions, validator rules + line-precise error UX.
- [How are shared state (blackboard) and per-task workspaces isolated?](issues/04-blackboard-workspace-isolation.md) — blackboard = runner-derived materialized view of message flow (no actor writes), persisted to `runs/<run-id>/blackboard.json`; workspace = integration-tree worktree architecture (task worktrees branch from integration state; `complete_task` owner-only tool atomically merges — success = done, conflict = in-loop error) or shared mode; lifecycle: abort retains all, resume rebuilds from disk (simple no-exactly-once), 60-day auto-GC + `/graph gc`, `/graph delete`.

## Not yet specified

<!-- in-scope fog; graduates as the frontier advances -->

- **Spec authoring (RFC consolidation)** — merging the envelope, grammar, state, and event-schema answers into `plans/actor-graph-rfc.md`; sharp only once those tickets close.
- **Extension scaffold & registration** — directory layout (e.g. `pi-graph/`), registration under root `package.json` `pi.extensions`, test wiring.
- **Runner implementation slices** — YAML parser/validator, session coordinator (spawn/name/lifecycle of headless sessions), channel router, `emit` tool implementation, revision-loop iteration counters; sized after the spec exists.
- **TUI progress component** — the trigger-session widget consuming the event stream; shape depends on the event schema ticket.
- **Tests + acceptance run** — unit tests under the extension dir, `bun run verify` green, example graph end-to-end.

## Out of scope

<!-- work ruled beyond the destination; never graduates -->

- **Multi-graph parallelism** — running several graphs concurrently; deferred by explicit user decision.
- **Dispatch escape hatch (C-model routing)** — dynamic per-message addressing via a runner-provided `dispatch` tool; deliberately post-v1, add without breaking the channels schema.
- **Modifying command-center** — this effort must not touch the command-center extension.
- **LLM-generated dynamic graphs** — graphs are authored YAML, not generated on the fly from conversation intent.
