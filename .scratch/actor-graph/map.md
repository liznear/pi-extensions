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
