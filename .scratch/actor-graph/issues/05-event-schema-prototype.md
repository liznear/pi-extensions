# Ticket 05: What event stream suffices to render the graph dashboard?

Status: resolved
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

## Answer

Prototype-driven resolution (2026-08-22). The artifact — schema + pure dashboard reducer + scripted-run demo — lives in [prototype/](../prototype/) (`bun .scratch/actor-graph/prototype/demo.ts`), driven event-by-event with the user. `bun run verify` green.

### Schema

Runner-stamped envelope on every event: `{v: 1, seq, ts, run_id, graph_id}` — `seq` run-local, gap-free, monotonic → total order + dedup + **resume cursor** (resume = replay, proven by the demo's every-frame-is-replay TUI). **23 event types, 6 families**: graph (started/completed/failed/aborted), task (created/done/failed), actor (planned/spawned/busy/idle/tool/exited), message (emitted/emit_refused/routed/delivered), integration (worktree_created/deleted, merge_attempted/succeeded/conflicted), intervention (steer_sent).

### Correlation

Stable ids in event bodies (actor = Pi session name, `msg_id`, `task_id`); **all views derived** — message traversal = emitted(msg_id) → routed(msg_id, channel, iteration) → delivered(msg_id, to) per recipient; blackboard = derived from task + message events (**no blackboard-mutation events by design** — it cannot disagree with the flow).

### Consumption surface (per ticket 01)

1. In-process reducer (the runner's own dashboard state). 2. Append-only `runs/<run-id>/events.jsonl` — evidence bundle beside `blackboard.json`; `/graph resume` + late viewers replay it. 3. pi-intercom **extension channel** `actor-graph/v1` for the trigger-session TUI (16 KiB cap → `payload_preview` ≤200 chars, never full payloads).

### Decisions grilled during reaction (all applied)

| Question | Outcome |
| --- | --- | --- |
| Message-flow granularity | **Keep stage-split** (emitted → routed → delivered-per-recipient) — stuck-between-stages must be visible live |
| `message_routed` `task_id` | **Added** — raw-log self-sufficiency (greppable per task, no joins) |
| `merge_attempted` | **Kept**; terminal merge events gained `duration_ms` |
| `graph_resumed` | **No event** — resume invisible; re-spawned actors mark it via `actor_spawned` |
| Not-carried line | **Stands** — with the condition that actor transcripts (`pi --resume`) are the always-reachable detail plane; final widget surfaces a per-actor resume hint |
| TUI presentation | quota-bearing loop channels only in the iteration line; exited actors stay, dimmed (post-mortem) |

### Deliberately NOT carried

Full message payloads · blackboard mutations · streaming/reasoning deltas · per-actor context/token usage (intercom presence has it) · anything multi-run · cost/latency accounting.

Assets: [prototype/events.ts](../prototype/events.ts) (schema), [prototype/dashboard.ts](../prototype/dashboard.ts) (reducer), [prototype/demo.ts](../prototype/demo.ts) (scripted 2-task run), [prototype/README.md](../prototype/README.md) (full writeup incl. final-widget ASCII mock).
