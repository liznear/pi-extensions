# Ticket 07: Write the actor-graph RFC consolidating the resolved decisions

Status: open
Type: task (AFK)
Parent map: [Actor-Graph map](../map.md)

## Question

Author `plans/actor-graph-rfc.md` — the single consolidated spec that merges every resolved decision from tickets 02–06 into one implementation-ready document. No new decisions: where the tickets conflict or leave gaps, surface them back to the map rather than deciding silently.

Sources to consolidate (in ticket order):

- **Envelope** ([02](02-intercom-envelope-mapping.md)): actor-declared + coordinator-stamped fields, emit customTool, `sendCustomMessage` delivery, `/graph steer`, boundary charter (no address fields; `when` = `msg.type` only; type-level context injection + `disable_graph_context`).
- **Channel grammar** ([03](03-channel-grammar-validation.md) + [research/03-channels-grammar-final.md](../research/03-channels-grammar-final.md)): full YAML grammar, semantics table, validator rules R1–R16, line-precise error UX, worked example.
- **State & workspace** ([04](04-blackboard-workspace-isolation.md)): blackboard as derived view, worktree/shared modes, `complete_task`/`task_complete_type`, lifecycle commands, retention.
- **Event schema** ([05](05-event-schema-prototype.md) + [prototype/](../prototype/)): envelope + 23 types / 6 families, correlation, consumption surfaces, not-carried list.
- **Acceptance** ([06](06-example-graph-acceptance.md)): two templates (review-pipeline, pair), two-tier acceptance bar, not-proven list, demo story.

The RFC must also carry: the SessionRunner seam (ticket 01's re-implementation surface), and a sizing proposal for the remaining execution slices (scaffold, runner, TUI, tests) as an input to graduating them from the map's fog.

## Context

- Graduated from map fog when ticket 06 closed — its stated dependency ("sharp only once those tickets close") is satisfied.
- AFK task: all answers exist; the work is consolidation. Where genuine gaps surface (e.g. grammar edge cases the worked example doesn't cover), list them in the RFC's "open questions" section and, if any is decision-shaped, propose new map tickets.
- Do not modify the source tickets or research files; the RFC is additive.
