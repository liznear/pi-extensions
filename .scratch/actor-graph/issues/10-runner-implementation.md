# Ticket 10: Implement the actor-graph runner

Status: open
Type: task (AFK)
Blocked by: [09 scaffold](09-scaffold-registration.md), [13 runner-facing semantics](13-runner-facing-semantics.md)
Parent map: [Actor-Graph map](../map.md)

## Question

Implement the execution engine per [actor-graph RFC](../../../plans/actor-graph-rfc.md) (the whole spec is normative for this slice; key sections referenced below), TDD-first where the code is pure:

1. **Parser + validator** (§3–4): YAML load with line/col preservation, R1–R16 with line-precise errors, adapted to whatever ticket 13 settles for OQ1 (runner pseudo-role) / OQ4 (multi-pipeline `create_task`).
2. **Session seam** (§2): `ActorSessionRunner` interface + `PiSessionRunner` (services-path spawn recipe incl. allowlist-rides-emit, lesson S1) + `FakeSessionRunner` for tests.
3. **Router + tools** (§5–6): emit tool with three refusal modes, `create_task` (planned registration + worktree branch), `complete_task` (atomic merge, §8), quotas per (role, type, task), iteration counters on back-edges only, lazy spawn (R13), stall detection + graceful drain (§6.6–6.8, incl. OQ5 completion semantics as settled).
4. **State** (§8–9): derived blackboard + `blackboard.json`, `events.jsonl` EventLog, workspace integration tree + task worktrees + merge events, abort/resume/gc/delete (runs dir per OQ7's settlement).
5. **Observability** (§10): schema-v1 events lifted from [prototype/events.ts](../prototype/events.ts), delivery-logged-before-sendCustomMessage (lesson S3), idle keyed on `agent_settled` (S4), intercom channel publish `actor-graph/v1`.

Acceptance: the Tier-1 items that don't need the widget or the full harness pass ad-hoc (both templates load + validate; quota loop terminates; lazy spawn works) — formal Tier 1 is ticket 12.

## Context

- Large: ~3–4 sessions. Recommendation from ticket 07's sizing: land parser/validator first (pure, unblocks rule tests), then seam + fake, then router/tools, then workspace/merge last.
- Blocked by 13 (OQ1–OQ7 decisions) so no silent decisions happen mid-implementation; blocked by 09 for the scaffold.
- Spike seed code exists: [poc/runner.ts](../poc/runner.ts) (runner shape), [poc/graph.ts](../poc/graph.ts) — re-implement into the extension, don't import the poc.
