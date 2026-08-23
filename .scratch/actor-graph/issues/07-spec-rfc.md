# Ticket 07: Write the actor-graph RFC consolidating the resolved decisions

Status: resolved
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
- AFK task: all answers exist; the work is consolidation. Where genuine gaps surface (e.g. grammar edge cases the worked example doesn't covered), list them in the RFC's "open questions" section and, if any is decision-shaped, propose new map tickets.
- Do not modify the source tickets or research files; the RFC is additive.

## Answer

**[The actor-graph RFC](../../../plans/actor-graph-rfc.md)** is authored at `plans/actor-graph-rfc.md` — 15 sections + template appendix, consolidating tickets 01–06 + spike 08. `bun run verify` green (292 tests, biome + tsc clean).

What it consolidates: runtime architecture (in-process services-path actors via the `ActorSessionRunner` seam from ticket 01, intercom as observation plane only), the YAML grammar + R1–R16 validator with line-precise errors, the envelope/emit contract, routing semantics (quotas, back-edge iteration counters, lazy spawn), workspace/blackboard/retention, event schema v1 (lifts [prototype/events.ts](../prototype/events.ts) verbatim), progress-TUI contract, two-tier acceptance, and all 9 spike lessons as a normative requirements table.

**Two micro-decisions were made, both explicitly delegated by ticket 08** (not silent): stall detection (all-idle + nothing in flight + not terminal → fast-fail `graph_failed`; distinct from the rejected watchdog) and graceful drain before dispose (spike lessons S7/S8).

**Seven decision-shaped gaps surfaced as OQ1–OQ7** (RFC §15, each with a recommendation, none decided):

1. **OQ1 runner-consumed message types** — R2 says `from`/`to` reference roles, but the runner mints/consumes messages; spike used pseudo-role `__runner__`. → recommend formalizing `runner`.
2. **OQ2** `no_matching_channel` refusal is statically unreachable under R1.
3. **OQ3 kickoff delivery** — how the human brief enters the graph was never pinned.
4. **OQ4 multiple per_task pipelines** — does `create_task` register all groups?
5. **OQ5 graph completion semantics** — all tasks terminal + nothing in flight?
6. **OQ6 blackboard read access** (ticket 04 "TBD-simple") + per-role `model:` selection.
7. **OQ7 runs-dir location** — genuine conflict: ticket 04 text says `~/.pi/graphs/runs/`, grammar addendum + spike use project-local `runs/` → recommend project-local.

**Sizing proposal** (RFC §14) graduates the map's fog into tickets 09–13: 09 scaffold (~1 session), 10 runner (~3–4 sessions), 11 TUI (~1 session), 12 tests/acceptance (~1–2 sessions), 13 grilling for OQ1–OQ7 (~1 session, HITL). Both shipped templates are written in full in the RFC appendix.
