# Ticket 04: How are shared state (blackboard) and per-task workspaces isolated?

Status: resolved
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

## Answer

Four decisions, grilled one at a time (2026-08-22).

### 1. Blackboard — runner-managed, file-persisted, derived-only

- **Storage**: runner holds it in memory, persists to `~/.pi/graphs/runs/<run-id>/blackboard.json`. The `runs/<run-id>/` directory is the run's complete evidence bundle (blackboard + event log + actor sessions + worktrees).
- **Content**: structured task state only (tasks table: id / status / assigned / payload summary). Large objects live in workspace files; messages carry **paths, not content**.
- **Access (v1)**: actors have **no write tools** — the blackboard is a pure **materialized view of the message flow** (runner derives status transitions from emitted/delivered messages). Decisions like abandoning a task are expressed as emitted messages (e.g. `task_abandoned`), never direct state writes. Read access TBD-simple (runner-derived view can be injected into prompts or exposed read-only if needed in implementation). Consequence: dashboard and blackboard can never disagree — every state change has a message.

### 2. Workspace — integration-tree worktree architecture

`workspace.mode: worktree | shared` (`isolated_dirs` cut — isolation without a merge primitive is a half-feature).

**worktree mode** (canonical for code graphs):

```
repo
 └─ runs/<run-id>/integration/   ← created by runner at graph start (the integration tree)
      ├─ runs/<run-id>/task-1/    ← task worktree, created from integration tree's CURRENT state
      ├─ runs/<run-id>/task-2/
```

- `create_task` → task worktree branches from the **latest integration state** (parallel execution, serialized integration).
- **`complete_task` tool** — injected only into the pipeline's `owner: true` role (exactly one owner per pipeline, R16). It atomically **attempts the merge into the integration tree: merge success = task done** (blackboard update + synthesized `task_done` message flows on); **merge conflict = tool error returned to the owner** ("integration has moved; resolve and complete again") — conflict handling is an in-loop actor cycle, same convergence philosophy as emit quotas.
- The `merger` role becomes optional (an LLM reviewer before completion, not a merge mechanism).

**shared mode**: no isolation, no `complete_task`; task terminal state via a declared `task_complete_type` message. **R15**: worktree or shared mode must have an identifiable task-terminal signal.

### 3. Lifecycle commands & retention

- Retained until explicit delete: integration tree, blackboard, event log, actor sessions. **Task worktrees are deleted immediately after successful merge** (failed/incomplete ones retained).
- **Auto-GC** on graph start: runs completed > **60 days** ago are cleaned. Manual **`/graph gc [--days N]`** also available.
- **`/graph abort`**: sessions disposed (transcripts already persisted per-actor), state marked `aborted`, everything retained.
- **`/graph resume <run-id>`**: rebuild runner state from blackboard + event log; re-spawn surviving actors (transcripts auto-resume via per-actor cwd `SessionManager.create`). In-flight message semantics kept deliberately simple (user: 简化一点): an emit already in the event log is treated as processed; un-emitted work is lost — no exactly-once in v1.
- **`/graph delete <id>`**: full cleanup (integration tree + task worktrees + runs dir).

### Consequences

- Grammar addendum needed in [research/03-channels-grammar-final.md](../research/03-channels-grammar-final.md): `workspace` section, `nodes[].owner: true`, `task_complete_type` (shared mode), R15/R16.
- Ticket 05 inherits: blackboard mutations (derived) and workspace events (merge attempted/succeeded/conflicted, worktree created/deleted) join the event taxonomy; node states extend with task-done semantics.
- Ticket 06 inherits: canonical example simplifies (merger optional; coder is the owner calling complete_task).
- Command surface grows: `/graph run | steer | gc | abort | resume | delete`.
