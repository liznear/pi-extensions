# PROTOTYPE (throwaway) — ticket 05: event schema + dashboard

> **Question** ([ticket 05](../issues/05-event-schema-prototype.md)): what event stream suffices to render the graph dashboard — observability rich enough that a TUI progress view in the triggering session can be built on the emitted events?
>
> This artifact exists to be **reacted to**, not approved. The schema will change under review.

**Run it** (from repo root):

```text
bun .scratch/actor-graph/prototype/demo.ts            # interactive: n/p/a/r/q
bun .scratch/actor-graph/prototype/demo.ts --auto 150 # non-interactive replay
```

## What's here

| File | Status | What it is |
| --- | --- | --- |
| `events.ts` | **the artifact** | event schema: envelope + 23 event types across 6 families |
| `dashboard.ts` | liftable | pure reducer: fold events → dashboard state (proves the schema drives the TUI *and* that resume = replay) |
| `demo.ts` | throwaway | scripted 2-task `review-pipeline` run (revision loop, quota refusal, merge conflict, human steer) replayed event-by-event |
| `README.md` | this | review surface: mock, consumption surface, not-carried list |

The demo TUI replays the event log one event per keypress — every frame is `replay(events[0..n])`, which is exactly the property `/graph resume` needs (ticket 04: rebuild from blackboard + event log).

## Envelope + correlation

Every event carries the runner-stamped envelope:

```ts
{ v: 1, seq: 104, ts: 1755851370000, run_id: "run-demo", graph_id: "review-pipeline" }
```

- `seq` is **run-local, gap-free, monotonic** — total ordering, dedup, and the resume cursor (an emit already in the log is processed).
- Correlation is by **stable ids carried in event bodies**: `actor` (Pi session name, e.g. `coder-for-t1`), `msg_id` (ULID), `task_id`. Events are self-contained facts; **all views are derived** — the dashboard folds:
  - message traversal: `message_emitted(msg_id)` → `message_routed(msg_id, channel, iteration)` → `message_delivered(msg_id, to)` (one per recipient, multicast = N)
  - actor state: `actor_planned` → `actor_spawned` → `actor_busy/idle/tool` → `actor_exited`
  - blackboard-style task state: derived from `task_created/done/failed` + routed messages (ticket 04: blackboard is a materialized view of the message flow — **there are no blackboard-mutation events by design**)

## Taxonomy (23 types, 6 families)

| Family | Types |
| --- | --- |
| graph | `graph_started` `graph_completed` `graph_failed` `graph_aborted` |
| task | `task_created` `task_done` `task_failed` |
| actor | `actor_planned` `actor_spawned` `actor_busy` `actor_idle` `actor_tool` `actor_exited` |
| message | `message_emitted` `emit_refused` `message_routed` `message_delivered` |
| integration | `worktree_created` `worktree_deleted` `merge_attempted` `merge_succeeded` `merge_conflicted` |
| intervention | `steer_sent` |

Notes on shape decisions (settled in review, 2026-08-22):

- **Message flow stays stage-split** — `emitted → routed → delivered` (per recipient): live stage-by-stage visibility; a message stuck between stages is diagnosable from the stream alone.
- **Loop events are not a family** — "iteration N of max" rides on `message_routed` (`iteration`, `iteration_max`), the quota story rides on `emit_refused` (`quota: {used, max}`), and merge duration rides on the terminal merge events. One place per fact.
- **`message_routed` carries `task_id`** — self-sufficiency: the raw log is greppable per task without joins (duplication accepted).
- **No `graph_resumed` event** — resume continues the same log; re-spawned actors already mark it via `actor_spawned`.
- **`merge_attempted` kept** — live "merging…" state; `merge_succeeded`/`merge_conflicted` carry `duration_ms`.
- **Refusals are events** (`emit_refused` carries the exact in-turn tool error) — the dashboard can show *why* a loop stalled without reading actor transcripts.
- **`payload_preview` only** (≤200 chars). Full payloads never ride events (ticket 04 paths-not-content); full text lives in actor transcripts (`pi --resume`) — the dashboard's detail plane, always reachable per actor.
- **`actor_tool` is collapsed** — one event per tool start/end with a one-line detail, not Pi's raw streaming event firehose. The coordinator (which sees `session.subscribe` raw events) does the collapsing.
- **Synthesized messages are marked** — `message_emitted.via: "emit" | "synthesized"` distinguishes actor emits from runner-minted ones (`task_done` after a successful merge).
- **Presentation calls** (TUI, not schema): task rows show quota-bearing loop channels only (`review 2/3 · revise 1/3`, no `assign 0 · done 0` noise); exited actors stay visible, dimmed, for post-mortem.

## Dashboard mock — final widget, embedded in the trigger session

What the real custom TUI component would render (the demo's terminal frame is a cruder ancestor of this):

```text
┌─ ▶ review-pipeline · run-8f2 · RUNNING (worktree) ── 2 tasks · 16 msgs ── 14:32:07 ┐
│ TASKS                                                                              │
│  t1  add user login endpoint        DONE      merged @a1b2c3d                      │
│      review 2/3 · revise 1/3 · merge: ✓                                          │
│  t2  add rate limiter middleware    RUNNING  review 3/3 · revise 3/3               │
│      ⚠ quota: pr_ready 3/3 used · merge: —                                        │
│ ACTORS                                                                            │
│  coordinator         singleton    · idle      last: create_task ✓ (t2)            │
│  coder-for-t1   t1   owner        ✕ exited    last: complete_task ✓               │
│  critic-for-t1  t1                ✕ exited    last: lgtm                          │
│  coder-for-t2   t2   owner        ◆ executing bash (npm run bench)                │
│  critic-for-t2  t2                ● thinking  last: revision (revise 3/3)         │
│ MESSAGES                                                      INTEGRATION         │
│  14:32:05  m13 revision    critic-for-t2 ─ revise 3/3 →  coder-for-t2 ✓⇢steer     │
│  14:32:01  m12 pr_ready    coder-for-t2  ─ review 3/3 →  critic-for-t2 ✓⇢steer    │
│  14:31:58  REFUSED pr_ready coder-for-t2 [3/3] "pr_ready 已用完 3 次 (t2)…"        │
│  14:31:52  m11 revision    critic-for-t2 ─ revise 2/3 →  coder-for-t2 ✓⇢steer     │
│  14:31:20  STEER  human → coder-for-t2 "watch the shared throttle config…"         │
│  14:31:04  t1 merged @a1b2c3d · conflict earlier resolved (1 file)                │
│                                                             [n] more …            │
└─ /graph steer · /graph abort ───────────────────────────────────────────────────── ┘
```

Glyphs: `· idle` `● thinking` `◆ executing` `○ planned` `✕ exited` · `✓⇢steer` = delivered into a busy session's steer queue · `✓` = triggered a turn.

## Consumption surface

Matches what ticket 01 found observable — one schema, two sinks, one transport:

1. **In-process (the runner itself)**: the coordinator emits each event while folding `session.subscribe` raw events; `dashboard.ts`'s reducer is the in-process consumer. Also persisted append-only to `runs/<run-id>/events.jsonl` — the run's evidence bundle next to `blackboard.json` (ticket 04).
2. **Cross-process (the trigger session's TUI)**: the same events published on a pi-intercom **extension channel** (`intercom:extension-register`, namespace `actor-graph/v1`), which command-center already proved for progress fan-out — channel traffic never enters transcripts and never triggers a turn. The 16 KiB publish cap is why events carry `payload_preview`, not payloads.
3. **Replay**: `/graph resume <run-id>` and any late-joining viewer tail/replay `events.jsonl` — `seq` gap-freeness makes dedup trivial.

## Deliberately NOT carried (the consciously drawn line)

A future dashboard might want these; this schema refuses them on purpose:

- **Full message payloads** — preview only. Full text lives in actor transcripts; the event log stays small and re-readable.
- **Blackboard mutations** — the blackboard is derived (ticket 04); emitting both would allow the two to disagree.
- **Streaming deltas / partial tool output / LLM reasoning** — `actor_tool` is collapsed to start/end + one-line detail. Token-level telemetry would flood the channel.
- **Context/token usage per actor** — pi-intercom presence already carries `contextPct`; the TUI can join it if wanted, the graph event stream doesn't duplicate it.
- **Anything multi-run** — one stream per run; cross-run/GC views read the `runs/` directory, not events.
- **Cost/latency accounting** — derivable later from timestamps if anyone cares; not a v1 fact.
- **A `graph_resumed` event** — settled in review: no. Resume continues the same log; re-spawned actors already mark it.

## Settled during review (2026-08-22)

| Question | Outcome |
| --- | --- |
| Message-flow granularity (3–4 events vs composite) | **Keep the stage split** — stuck-between-stages must be visible live |
| `message_routed` missing `task_id` | **Added** — raw-log self-sufficiency over normalization |
| `merge_attempted` worth its slot? | **Kept**, terminal events gained `duration_ms` |
| `graph_resumed` event? | **No** — resume is invisible; `actor_spawned` re-spawns mark it |
| The not-carried line | **Stands**, on the condition that actor transcripts (`pi --resume`) are the always-reachable detail plane — the final widget should surface the resume hint per actor |
| Forward-channel iteration noise | **Cut** — quota-bearing loop channels only |
| Exited actors in the table | **Stay, dimmed** — post-mortem value |
