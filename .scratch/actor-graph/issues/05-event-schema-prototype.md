# Ticket 05: What event stream suffices to render the graph dashboard?

Status: open
Type: prototype
Parent map: [Actor-Graph map](../map.md)

## Question

Produce a **rough, concrete event schema + TUI sketch** to react to — the destination demands events rich enough to build the dashboard, so prove it by sketching one:

1. Event taxonomy: graph lifecycle (started/completed/failed), node lifecycle (spawned, idle, thinking, executing, exited — including which actor session), message flow (envelope emitted, channel matched/not-matched, delivered), blackboard mutations (from Ticket 04), loop events (revision iteration N of max).
2. Envelope of each event: timestamp, graph-id, task-id, actor identity, event-specific payload. Correlation: how the dashboard reconstructs "message X traversed channel Y from node A to node B" from the stream.
3. A **crude TUI mock** (ASCII sketch is fine, or a throwaway component) of the trigger-session progress view: node states, message flow log, iteration counters — enough to judge whether the schema can actually drive it.
4. Consumption surface: how the TUI subscribes (extension event emitter? intercom broadcast? file tail?) — must match what Ticket 01 found observable.
5. Explicitly list what a future dashboard might want that this schema deliberately does NOT carry (so the line is drawn consciously, not accidentally).

## Context

- Prototype (HITL): the artifact exists to be reacted to; expect the schema to change under review.
- Independent of the channel grammar (Ticket 03) but should reference the envelope concept from Ticket 02 abstractly (payload as opaque field); don't block on it.
- The acceptance ticket (Ticket 06) will use this schema to define "dashboard-sufficient".
