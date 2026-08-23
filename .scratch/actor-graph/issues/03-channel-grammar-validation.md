# Ticket 03: What is the YAML grammar for channels, and what can be statically validated?

Status: resolved
Type: grilling
Parent map: [Actor-Graph map](../map.md)

## Question

Finalize the **channels DSL grammar** and the validator's guarantees:

1. Full grammar for the `channels` section: `from`/`to` role references, `when` conditions over envelope fields (`msg.type`), `scoped_to: task`, and `max_iterations` (pin ③) with its overflow policy (who is notified when a revision loop exhausts — coordinator? human?).
2. The `roles` section's `emits` declaration (pin ②): syntax, and the static checks it unlocks (unmatched emits, channels referencing undeclared types, unreceivable message types — list every validator rule precisely).
3. The `nodes` section: `singleton` vs `per_task` lifecycle declarations, and how a per-task pipeline is expressed (roles composed per task instance).
4. Versioning/validation UX: what does a load-time error look like for the graph author? Line-precise YAML errors vs. structural messages.
5. A complete worked example in the final grammar — the coder→critic→merger graph with revision loop and max_iterations — as the grammar's acceptance test.

## Context

- Depends on the envelope shape (Ticket 02); conditions operate on envelope fields.
- The example produced here is input to the acceptance ticket (Ticket 06).
- Constraints already locked: pure declarative routing, no dispatch/escape hatch in v1 (see map Notes).

## Answer

Full grammar + worked example + validator rules + error UX live in [research/03-channels-grammar-final.md](../research/03-channels-grammar-final.md) (supersedes [drafts/03-channels-grammar-v1.md](../drafts/03-channels-grammar-v1.md), which retains cut syntax). Decisions made during grilling, one at a time (2026-08-22):

1. **Multicast is explicit, ambiguity is an error.** `to` accepts a string or array ("抄送" as an explicit list); one emit matches at most one channel — two channels with same `from` + overlapping `when` values fail load (R11). No implicit fan-out, no match ordering.
2. **Terminology pinned**: the routing/stamping extension code is the **graph-runner** (no LLM); "coordinator" is just an ordinary role name in a graph. Messages only originate from actors; the runner only stamps, delivers, and emits dashboard events.
3. **Task factory = `create_task` tool, lazy physical spawn.** A `can_create_tasks: true` role calls `create_task(payload)` → runner mints `task_id` and registers the pipeline's per_task nodes in `planned` state (dashboard-visible immediately); actual sessions spawn lazily on the first message routed to `<role, task_id>` (R12/R13/R14).
4. **Loop protection = per-type quotas, not edge counters.** `max_iterations` and watchdog were both rejected: legal loop length is task-intrinsic (pair-programming rounds). Quotas live on the emit type declaration (`max_per_task`, counted per `(role, type, task)`); at quota the emit tool errors in-turn ("已用完 N 次，请 lgtm 或升级") so the LLM converges INSIDE the conversation instead of being externally cut off. Free-form types omit the quota. The `loop: true` field was cut — back-edges are statically derived (topo sort, informational only).
5. **Tool scoping is physical, not permission-based.** `emit` (all actors) and `create_task` (gated roles) are injected via `customTools` ONLY into graph-spawned sessions — they do not exist in normal sessions. `/graph steer` exists only in the trigger session.

Ticket 06 inherits the worked example (review-pipeline) as its canonical acceptance graph. Ticket 05 inherits the node-state vocabulary `planned → spawned → idle/thinking/executing → exited` and the channel/message event shapes.
