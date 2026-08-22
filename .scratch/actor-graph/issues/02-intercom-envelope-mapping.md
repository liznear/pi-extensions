# Ticket 02: How does the typed message envelope map onto intercom send/ask/reply?

Status: open
Type: grilling
Blocked by: 01
Parent map: [Actor-Graph map](../map.md)

## Question

Design the **typed message envelope** — the emit contract every actor uses to put a message on a channel — and pin its mapping onto pi-intercom primitives:

1. Envelope fields: message `type` (from the role's declared `emits`), payload, task-id scope, iteration counter, sender identity. What exactly crosses the wire?
2. Mechanics: does an actor `emit` via a runner-provided tool that then does the intercom `send`? Or does the runner watch for structured output? Who translates envelope → intercom message and back?
3. Sync vs async: when (if ever) does the graph use `ask`/`reply` (blocking) vs `send` (fire-and-forget)? Revision loops suggest `send` — confirm and justify.
4. Naming/addressing: how task-scoped identities (`coder-for-task-1`) are minted and resolved so channels with `scoped_to: task` route to the right instance.
5. What the envelope deliberately leaves out (routing decisions belong to channels, not payloads) — the boundary that keeps this from becoming the dispatch escape hatch.

## Context

- Depends on Ticket 01's findings about what intercom supports for spawned sessions.
- This envelope is pin ① of the routing decision (see map Notes) and feeds both the channel grammar (Ticket 03) and the event schema (Ticket 05).
