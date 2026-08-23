# Ticket 11: Build the TUI progress widget

Status: open
Type: task (AFK)
Blocked by: [09 scaffold](09-scaffold-registration.md)
Parent map: [Actor-Graph map](../map.md)

## Question

Build the trigger-session progress widget per [actor-graph RFC §11](../../../plans/actor-graph-rfc.md):

1. Lift the reducer from [prototype/dashboard.ts](../prototype/dashboard.ts) into `actor-graph/src/dashboard.ts` (schema from `src/events.ts`) — the prototype proved every frame is replay.
2. Implement `tui/widget.ts` rendering the RFC's target mock (node states with glyphs, task rows with quota-bearing iteration lines only, message flow log, integration column, per-actor resume hint; exited actors dimmed).
3. Input priority: in-process emitter → intercom channel `actor-graph/v1` → `events.jsonl` replay (for `/graph resume` late-joining).
4. `/graph steer` actor-name autocomplete over the live actor list.

Develop against replayed `events.jsonl` (spike runs exist under `runs/run-spike-*`, and ticket 10 will produce more) — no live LLM needed to build this.

## Context

- Medium: ~1 session. Graduated from map fog by [ticket 07](07-spec-rfc.md); sizing per RFC §14.
- Blocked by 09 (scaffold + registration) only — parallel to 10 once scaffold exists.
- Pattern reference: command-center's mission widget (re-implement, never import — map constraint).
