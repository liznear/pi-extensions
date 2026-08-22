# Ticket 04: How are shared state (blackboard) and per-task workspaces isolated?

Status: open
Type: grilling
Blocked by: 01
Parent map: [Actor-Graph map](../map.md)

## Question

Design the **state model** — the two state tiers from the handoff — concretely:

1. **Shared blackboard / global store**: what lives in it (mission prompt, plan, per-task status, artifacts?), how actors read/write it (runner-provided tool? file convention?), how updates broadcast, and what a dashboard needs from it. Is it in-memory in the runner, or file-backed (and if file-backed, where — `~/.pi/graphs/` sibling dir? repo-local?)?
2. **Node-local state**: per-task session memory is isolated by construction (fresh sessions); what remains to decide — e.g. singleton node memory persistence across the graph run, and what survives graph termination.
3. **Workspace/git isolation**: do per-task actors (multiple coders on different tasks) share one working tree, get per-task worktrees, or per-task directories? Cost/complexity trade-off for the PoC, and how the choice interacts with a merger node.
4. **Failure & cleanup semantics**: what happens to blackboard + workspaces when a graph fails, is cancelled, or completes — what's the retention story (post-mortem debugging needs it).

## Context

- Depends on Ticket 01 (session/workspace mechanics the runner actually has).
- Node-local vs shared boundary feeds the event schema (Ticket 05) — blackboard updates should be observable events.
