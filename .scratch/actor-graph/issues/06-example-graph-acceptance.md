# Ticket 06: Which example graph proves the PoC, and what is acceptance?

Status: open
Type: grilling
Blocked by: 03, 05
Parent map: [Actor-Graph map](../map.md)

## Question

Pin the **example graph and the acceptance bar** for the PoC:

1. The canonical example: coder→critic→merger with a revision loop and `max_iterations`, written in the final grammar (from Ticket 03) — plus one or two built-in templates shipped with the extension (user decided: templates ship but are zero runtime dependency).
2. Acceptance criteria, concretely testable: e.g. graph loads from `~/.pi/graphs/`, revision loop actually iterates and terminates at max, trigger session renders live progress from events (per Ticket 05's schema), `bun run verify` green.
3. What is deliberately NOT proven by the PoC (dispatch-style dynamic routing, multi-graph parallelism — already out of scope; anything else surfaced by writing the acceptance list).
4. Demo/story: the exact commands a user runs (install → place graph YAML → trigger in a pi session), as the handoff script for whoever implements.

## Context

- Blocked by the channel grammar (Ticket 03) and event schema (Ticket 05) — acceptance references both.
- This ticket closes the decision phase; after it resolves, the map's remaining work is execution slices (spec authoring, scaffold, runner, TUI, tests — see map fog), sized per the spec.
