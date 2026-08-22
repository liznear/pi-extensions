# Ticket 02: How does the typed message envelope map onto intercom send/ask/reply?

Status: resolved
Type: grilling
Blocked by: 01
Parent map: [Actor-Graph map](../map.md)

## Question

Design the **typed message envelope** — the emit contract every actor uses to put a message on a channel — and pin its mapping onto pi-intercom primitives:

1. Envelope fields: message `type` (from the role's declared `emits`), payload, task-id scope, iteration counter, sender identity. What exactly crosses the wire?
2. Mechanics: does an actor `emit` via a runner-provided tool that then does the intercom `send`? Or does the runner watch for structured output? Who translates envelope → intercom message and back?
3. Sync vs async: when (if ever) does the graph use `ask`/`reply` (blocking) vs `send` (fire-and-forget)? Revision loops suggest `send` — confirm and justify.
4. Naming/addressing: how task-scoped identities (`coder-for-task-1`) are minted and resolved so channels with `scoped_to: task` route to the right instance.
5. What the envelope deliberately leaves out (routing decisions belong to channels, not payloads) — the boundary that keeps this from becoming the dispatch escape hatch.

## Context

- Depends on Ticket 01's findings about what intercom supports for spawned sessions.
- This envelope is pin ① of the routing decision (see map Notes) and feeds both the channel grammar (Ticket 03) and the event schema (Ticket 05).

## Answer

Six decisions, grilled one at a time (2026-08-22). Grounding: [research/01-session-spawning.md](../research/01-session-spawning.md).

### 1. Runtime topology — in-process SDK sessions

Actors are spawned **in-process** via `createAgentSession` (coordinator holds session objects directly). Consequently **intercom is NOT the actor message bus** — it becomes the observation plane: session naming/mirrored presence + pi-intercom extension channels for dashboard fan-out. Message delivery is in-process function calls. Accepted PoC fault domain: coordinator dies → graph dies. SessionRunner seam (command-center pattern, re-implemented) keeps future paths open: detached headless coordinator process, or RPC subprocess runner per actor.

### 2. Envelope — actor fields + coordinator routing stamps

```yaml
# actor-declared (via emit tool)
msg_id:    ulid
type:      pr_ready        # must be in role's emits list (pin ②)
task_id:   task-1
payload:   { ... }          # typed free payload, schema per graph

# coordinator-stamped at routing time
sender:    coder-for-task-1 # auto-filled (anti-forgery; actor cannot claim another identity)
iteration: 2               # maintained per (channel, task) — counts only BACKWARD messages on loop edges
channel:   critic2coder    # match record
```

Iteration semantics: forward messages never increment; only reverse-traversal on a loop edge does. Reaching `max_iterations` (pin ③) → channel **refuses delivery** and triggers the termination policy (escalate to coordinator or human). Actor stays ignorant of iteration counts — the counter is routing-layer state.

### 3. Emit — a customTool, the only structured exit

`emit({type, task_id, payload})` registered per-actor via `customTools`. No structured-output parsing. Key win: a refused emit returns a **tool error to the actor in-turn** — the feedback loop the termination policy needs.

### 4. Delivery — sendCustomMessage, verified persistent

Coordinator delivers routed envelopes via `session.sendCustomMessage({customType: "graph_message", content: envelope}, {triggerTurn: true})`. Verified from source (`agent-session.js:1068`): every path persists to transcript history — idle+triggerTurn via `_runAgentPrompt`, busy via steer/followUp queue, idle+no-trigger via `appendCustomMessageEntry`; history load reads them back. Backpressure = Pi's native steer queue. No `prompt()` mixing, no user-role spoofing.

### 5. Human observation & intervention — persisted sessions + steer

- **Persist**: actors use `SessionManager.create(per-actor-cwd)` (not inMemory) — resumable via `pi --resume` for post-mortem. (command-center-verified pattern.)
- **Dashboard**: ticket 05's event schema renders live progress in the trigger session.
- **Live intervention**: `/graph steer <actor> <text>` — coordinator calls `session.steer()`. **Actor-name autocomplete required** (pi slash-command completion callback over live actor list). No attach/bidirectional actor chat in v1.

### 6. Boundary charter — envelope owns "what", channels own "where"

- Envelope has **no `to`, no `reply_to`, no address field** — the emit tool schema physically lacks them. "Reply" = emit a new message that goes through normal channel matching.
- `when` predicates: v1 whitelist is **`msg.type` only** (payload predicates are the dispatch escape hatch's territory — out of scope).
- **Actor awareness**: default ON — coordinator injects a **type-level upstream/downstream view** into each actor's system prompt (message types ↔ roles, never instance names like `critic-for-task-1`) via template variables. Per-role opt-out: `disable_graph_context: true` lets the graph author hand-write the prompt with zero priors. This supersedes the `graph_context()` runtime-tool idea discussed mid-grill.

### Consequences for other tickets

- Ticket 03 inherits: `emits` declarations, `when: msg.type` only, `disable_graph_context` role field, template-variable prompt mechanism, loop-edge `max_iterations` + termination policy grammar.
- Ticket 05 inherits: stamped envelope (sender/iteration/channel) is the message-flow event's payload shape.
- Implementation notes for the spec: emit tool JSON schema, `graph_message` customType convention, `/graph steer` completion callback, per-actor `SessionManager.create` wiring.
