# Ticket 13: Runner-facing semantics — resolve the RFC's open questions

Status: open
Type: grilling (HITL)
Parent map: [Actor-Graph map](../map.md)

## Question

Resolve OQ1–OQ7 from [actor-graph RFC §15](../../../plans/actor-graph-rfc.md) — the decision-shaped gaps ticket 07 surfaced while consolidating, each with a recommendation to react to. Grill one at a time:

1. **OQ1 — runner-consumed message types**: R2 says channel `from`/`to` reference declared roles, but the runner mints (kickoff, `task_done`) and consumes (`task_complete_type`, terminals) messages; the spike used pseudo-role `__runner__`. Recommend: formalize pseudo-role `runner` in `from`/`to`; R1 exempts types consumed by a `to: runner` channel.
2. **OQ2 — `no_matching_channel` reachability**: statically unreachable under R1 as written. Recommend: keep the enum value (defensive), document unreachability.
3. **OQ3 — kickoff delivery**: how the human brief enters the graph was never pinned. Recommend: runner-synthesized message to all eagerly-spawned singletons.
4. **OQ4 — multiple per_task pipelines**: does `create_task` register all per_task node groups? Recommend: yes; groups spawn independently.
5. **OQ5 — graph completion semantics**: recommend all created tasks terminal + nothing in flight → drain → `graph_completed`.
6. **OQ6 — blackboard read access + per-role model**: recommend no read API in v1; no per-role model in v1.
7. **OQ7 — runs directory location**: genuine conflict — ticket 04 text says `~/.pi/graphs/runs/`, grammar addendum + spike use project-local. Recommend project-local `<cwd>/runs/<run-id>/`.

Each resolution updates the RFC in place (it is the consolidated spec — decisions land there, §15 shrinks).

## Context

- HITL grilling: ~1 session, one question at a time (map Notes; /grilling + /domain-modeling skills).
- Graduated from map fog by [ticket 07](07-spec-rfc.md) — these gaps were surfaced, deliberately not decided, during consolidation.
- Blocks [10 runner implementation](10-runner-implementation.md) (which needs the semantics settled).
- Not blocked by anything — takeable now (frontier).
