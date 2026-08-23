# Ticket 12: Tier-1 test harness and acceptance run

Status: open
Type: task (AFK)
Blocked by: [10 runner](10-runner-implementation.md), [11 TUI](11-tui-progress-widget.md)
Parent map: [Actor-Graph map](../map.md)

## Question

Make the acceptance bar from [actor-graph RFC §12](../../../plans/actor-graph-rfc.md) (from ticket 06) executable and green:

1. **Tier 1 — all 8 items automated in `bun run verify`** via `FakeSessionRunner` over both templates:
   1. graph loads from `~/.pi/graphs/`; both templates validate clean
   2. validator rules R1–R16 fire with line-precise errors on mutated fixtures
   3. revision loop iterates and terminates at quota (in-turn tool errors; refusal event logged)
   4. lazy spawn + `planned` registration at `create_task`
   5. merge conflict → in-loop tool error → resolution → `merge_succeeded` + `task_done` on a self-generated fixture repo
   6. event stream matches schema v1 (types, envelope, gap-free seq, stage-split message flow)
   7. abort mid-run → `/graph resume` → replayed blackboard/event state matches pre-abort
   8. `/graph gc --days N` and `/graph delete` clean up run artifacts
2. **Tier 2 — demo readiness**: `bun run demo:graph` scaffolds the throwaway repo (minimal `package.json` per spike lesson S6, omission-fix task design per S9) and prints the RFC §12 handoff script.
3. Real Tier-2 run is **manual** (one live-LLM review-pipeline run watched in the widget) — not a CI gate; report its outcome to the map.

## Context

- Medium: ~1–2 sessions. Graduated from map fog by [ticket 07](07-spec-rfc.md); the bar itself was set by [ticket 06](06-example-graph-acceptance.md).
- Blocked by 10 and 11. Fixture repo generation must mkdir before any spawnSync (spike lesson S5).
- Deliberately not proven (RFC §12): LLM convergence quality, cross-process fan-out, coordinator crash recovery, GC timing.
