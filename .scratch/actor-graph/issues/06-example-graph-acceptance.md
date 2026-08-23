# Ticket 06: Which example graph proves the PoC, and what is acceptance?

Status: resolved
Type: grilling
Blocked by: 05
Parent map: [Actor-Graph map](../map.md)

## Question

Pin the **example graph and the acceptance bar** for the PoC:

1. The canonical example: coder→critic→merger with a revision loop and `max_iterations`, written in the final grammar (from Ticket 03) — plus one or two built-in templates shipped with the extension (user decided: templates ship but are zero runtime dependency).
2. Acceptance criteria, concretely testable: e.g. graph loads from `~/.pi/graphs/`, revision loop actually iterates and terminates at max, trigger session renders live progress from events (per Ticket 05's schema), `bun run verify` green.
3. What is deliberately NOT proven by the PoC (dispatch-style dynamic routing, multi-graph parallelism — already out of scope; anything else surfaced by writing the acceptance list).
4. Demo/story: the exact commands a user runs (install → place graph YAML → trigger in a pi session), as the handoff script for whoever implements.

## Context

- Blocked by the event schema (Ticket 05) — acceptance references the final grammar (Ticket 03, resolved) and the event schema.
- This ticket closes the decision phase; after it resolves, the map's remaining work is execution slices (spec authoring, scaffold, runner, TUI, tests — see map fog), sized per the spec.
- Note: this body's mention of `max_iterations` predates Ticket 03's resolution — loops are `max_per_task` quotas in the final grammar; the answer below is pinned to the final grammar.

## Answer

Five decisions, grilled one at a time (2026-08-22).

### 1. Canonical example — the review-pipeline

The graph already used by the grammar research and the event-schema prototype: **coordinator** singleton (`can_create_tasks`) + **coder (owner)** + **critic** per-task; `task_assigned → pr_ready → revision/lgtm` loop under `max_per_task` quotas; worktree mode with integration tree + `complete_task` atomic merge (merger role optional/simplified per ticket 04). It exercises every routing pin in the final grammar.

### 2. Shipped templates — two, zero runtime dependency

- **`review-pipeline.yaml`** — the canonical example, as above (worktree mode, quotas, merge).
- **`pair.yaml`** — coordinator (`can_create_tasks`) + **driver ↔ navigator** pair per task: free-form typed messages with **no quotas** (the omitted-quota path), shared workspace, termination via `task_complete_type` when the pair concludes. Differing on every axis: quotas vs none, loop vs free exchange, worktree vs shared, merge vs complete-type.

### 3. Acceptance — two tiers

**Tier 1 (the bar, automated in `bun run verify`)** — a FakeSessionRunner harness (command-center's pattern, re-implemented) drives both templates mechanically, no real LLMs:

1. graph loads from `~/.pi/graphs/`; both templates validate clean
2. validator rules R1–R16 fire with line-precise errors on mutated fixtures
3. revision loop iterates and terminates at quota (emit tool errors in-turn; refusal event logged)
4. lazy spawn: first routed message to `<role, task>` spawns the session; `planned` state registered at `create_task`
5. merge conflict → in-loop tool error → resolution → `merge_succeeded` + `task_done` on a self-generated fixture repo
6. event stream matches schema v1 (types, envelope, gap-free seq, stage-split message flow)
7. abort mid-run → `/graph resume` → replayed blackboard/event state matches pre-abort
8. `/graph gc --days N` and `/graph delete` clean up run artifacts

**Tier 2 (the demo, manual)** — one real-LLM `review-pipeline` run in a real pi session, watched live, per the demo story below. Not a CI gate; the handoff script.

### 4. Deliberately NOT proven

Inherited out-of-scope: dispatch-style dynamic routing, multi-graph parallelism. Surfaced by this ticket:

- **LLM convergence quality** under quota pressure — fake sessions test the mechanism, not whether real prompts converge
- **Cross-process intercom channel fan-out** — in-process reducer tested; second-process consumption trusted from command-center's proof
- **Coordinator crash recovery** — accepted fault domain (coordinator dies → graph dies)
- **60-day auto-GC timing** — only `/graph gc --days N` is exercised

### 5. Demo story (handoff script)

Target: a **generated throwaway demo repo** — `bun run demo:graph` scaffolds a tiny git repo (README + a few source files) and prints next steps; 100% reproducible, touches nothing real.

```text
bun run demo:graph                                  # scaffold demo repo, print instructions
cp templates/review-pipeline.yaml ~/.pi/graphs/     # place graph YAML
cd <demo-repo> && pi                                # open pi in the demo repo
> /graph run review-pipeline                        # trigger; trigger session becomes progress view
…  watch widget: node states, message flow, iteration counters …
> /graph steer coder-for-task-1 "prefer table-driven tests"
> /graph abort | /graph resume <run-id> | /graph gc | /graph delete <id>
```

### Consequences

- The map's fog item "Spec authoring (RFC consolidation)" is now sharp → graduates to a ticket (blocked by nothing — the frontier). Scaffold/runner/TUI/tests stay fog until the spec sizes them, per this ticket's context note.
- Tier-1 items 7–8 (abort/resume replay, gc) were added during this grill — nearly free with fake sessions, and resume is the trickiest implemented path.
