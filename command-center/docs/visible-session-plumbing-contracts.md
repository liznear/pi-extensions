# Visible-session plumbing contracts

This note pins the contracts for a future Command Center adapter that drives a
**visible Pi session** (the user's current TUI/RPC session) instead of only the
current headless `PiSessionRunner`. It is a design/probe note, not production
code.

## Goals and non-goals

- Goal: define how a visible-session adapter maps Pi extension lifecycle/events
  into Command Center's role-scoped event stream.
- Goal: define when it is safe to inject text into the visible session and how
  queued injection behaves while the agent is busy.
- Goal: define how Command Center detects that the current visible session is the
  integration worktree (Mission Lead) or an owner worktree.
- Non-goal: change the existing `SessionRunner`, Orchestrator, or widget code in
  this spike.

## Evidence / probes

No throwaway runtime probe was needed. This contract is based on static probes of:

- `command-center/core/session.ts` and `command-center/core/events.ts` for the
  current normalized event vocabulary.
- `command-center/extensions/cc-missions-widget.ts` for current cwd-to-mission
  matching via `isInsideMissionWorktrees`.
- Pi SDK declarations/implementation from the installed package:
  - `core/extensions/types.d.ts` for `ExtensionContext`, `SessionStartEvent`,
    `SessionBeforeSwitchEvent`, and extension event payloads.
  - `core/agent-session.d.ts` / `core/agent-session.js` for `isIdle`,
    `sendUserMessage`, `deliverAs`, and raw session events.
- Existing extension usage in `diff/index.ts`, `explain/index.ts`, and
  `mini-task/index.ts` for practical `ctx.isIdle()` / `pi.sendUserMessage()`
  behavior.

## Role attachment model

A visible-session adapter owns at most one active `RoleIdentity` for the current
Pi session. Events are forwarded to Command Center only when the current session
is attached to a Command Center worktree.

Attachment is derived on every `session_start` from `ctx.cwd` and the persisted
mission list:

1. Normalize `ctx.cwd` and each mission's `repoPath` with `path.resolve`.
2. If `ctx.cwd === mission.repoPath`, the session is in the source repo. It is
   related for widgets/listing, but **not role-attached**; do not attribute agent
   events to a mission role.
3. If `isInsideMissionWorktrees(mission, ctx.cwd)` is false, ignore the mission.
4. For a matching worktree prefix
   `$HOME/.command-center/worktrees/<missionId>/`:
   - `integration` or a descendant of `integration` attaches as
     `{ missionId, roleName: "mission_lead" }`.
   - `work-<itemId>` or a descendant of `work-<itemId>` attaches as
     `{ missionId, roleName: "work_item_owner", workItemId: <itemId> }`.
   - Any other child under the mission worktree prefix is considered unknown and
     must not be role-attached.

`session_start` has `reason: "startup" | "reload" | "new" | "resume" | "fork"`
and optional `previousSessionFile`. Use it to recompute attachment and refresh
visible widgets. Do not auto-resume or drive a mission from `session_start`; drive
entry points stay explicit (`/cc launch`, `/cc resume`, replies, acceptance
commands, etc.).

`session_before_switch` has `reason: "new" | "resume"` and optional
`targetSessionFile`, but no destination cwd. Use it only for the current session:

- If the current visible session is role-attached and `!ctx.isIdle()`, cancel the
  switch with `{ cancel: true }` and notify the user that the Command Center role
  turn is still running.
- If idle, detach the current role and allow the switch. Re-attach, if applicable,
  on the following `session_start` for the replacement session.

## Raw event map and normalized payloads

When the visible session is role-attached, forward the same normalized events as
`normalizePiEvent(...)` so downstream Command Center code can remain insensitive
to whether the role is headless or visible. Every normalized payload is stamped by
`EventBus` with `{ ts, seq }` and includes the current role ref:

```ts
type RoleRef = {
  missionId: string
  roleName: "mission_lead" | "work_item_owner"
  workItemId?: number
}
```

### `message_update`

Raw extension shape:

```ts
{
  type: "message_update"
  message: AgentMessage
  assistantMessageEvent: { type: string; delta?: string; /* plus block fields */ }
}
```

Mapping:

- `assistantMessageEvent.type === "text_delta"` ->
  `{ type: "message-delta", ...roleRef, delta }`.
- `assistantMessageEvent.type === "thinking_delta"` ->
  `{ type: "reasoning-delta", ...roleRef, delta }`.
- Block boundary events (`start`, `text_start`, `text_end`, `thinking_start`,
  `thinking_end`, `toolcall_start`) are intentionally skipped.
- Unknown `assistantMessageEvent.type` values are skipped until explicitly
  adopted.

### `message_end`

Raw extension shape:

```ts
{ type: "message_end", message: AgentMessage }
```

Mapping:

- If `message.role === "assistant"`, emit
  `{ type: "message-ended", ...roleRef, message }`.
- Non-assistant message ends are skipped; tool results are represented by
  `tool-call-ended`.

### `tool_execution_start`

Raw extension shape:

```ts
{ type: "tool_execution_start", toolCallId: string, toolName: string, args: any }
```

Mapping:

```ts
{
  type: "tool-call-started",
  ...roleRef,
  toolCallId,
  toolName,
  args,
}
```

### `tool_execution_end`

Raw extension shape:

```ts
{
  type: "tool_execution_end",
  toolCallId: string,
  toolName: string,
  result: any,
  isError: boolean,
}
```

Mapping:

```ts
{
  type: "tool-call-ended",
  ...roleRef,
  toolCallId,
  toolName,
  result,
  isError,
}
```

### `agent_end`

Raw extension event shape is `{ type: "agent_end", messages: AgentMessage[] }`.
The lower-level `AgentSessionEvent` also carries `willRetry: boolean`, but the
extension event type does not expose it.

Mapping:

```ts
{
  type: "session-ended",
  ...roleRef,
  sessionId,
}
```

`agent_end` is a turn-boundary signal, not a durable mission-idle signal. If the
adapter needs to wait until no automatic retry, compaction retry, or queued
follow-up will run, prefer `agent_settled` / `ctx.waitForIdle()` where available.

## Verdict extraction and prompt framing

Canonical verdict extraction is tool-result based; do not parse ordinary prose as
state transitions.

- Work Item Owner completion: find a `tool-call-ended` event where
  `toolName === "request_review"`, `roleName === "work_item_owner"`, and
  `workItemId` matches the item. Extract `result.details.summary`.
- Work Item Owner blocker: find `toolName === "request_help"` for the owner item
  and extract `result.details.reason`.
- Mission Lead work-item verdict: find `toolName === "review_work_item"` with
  `roleName === "mission_lead"` and `result.details.workItemId` matching the
  item. Extract:
  - `details.decision`: `"accept" | "rework" | "cancel"`.
  - `details.feedback`: required for rework, optional otherwise.
  - `details.applied`: whether the tool already wrote the status / merge result.

Visible-session prompts must make the tool contract explicit. Frame injected
messages with a short Command Center header and a final imperative, for example:

```text
[Command Center]
Role: Work Item Owner for Mission <id>, Work Item #<n>

<assignment or feedback>

When complete, call request_review({ summary }) with a substantive summary.
If blocked before completion, call request_help({ reason }). Do not signal
completion in prose only.
```

For lead review prompts, end with:

```text
Inspect the owner's branch against integration, then call
review_work_item({ workItemId, decision, feedback? }). Do not provide the
verdict in prose only.
```

A fenced JSON verdict in the assistant's final text may be useful as a manual
recovery aid, but it must not be the primary state-transition path unless the
corresponding tool event is unavailable and a separate fallback contract is
implemented.

## `ctx.isIdle()` semantics

`ExtensionContext.isIdle()` is a session-local activity predicate. In the Pi SDK
version probed here, it is documented as "not streaming" / no active run; the
implementation returns the negation of the internal active-agent-run flag.

Use it for UI/session-safety decisions only:

- `true`: the current visible session is not actively streaming now; a normal
  `pi.sendUserMessage(...)` can start a turn.
- `false`: the current visible session is busy. Either wait (`ctx.waitForIdle()`
  in command contexts), refuse the user action, or call `pi.sendUserMessage` with
  an explicit `deliverAs` mode.

Do not use `ctx.isIdle()` to infer that a Mission is parked, accepted, or safe to
tear down. Mission state remains the Store/Plan status machine plus Driver Lock.
Also do not treat `agent_end` alone as equivalent to `ctx.isIdle() === true` when
a retry/compaction/follow-up may still run.

## `pi.sendUserMessage()` behavior and `deliverAs`

The extension-level API is:

```ts
pi.sendUserMessage(
  content: string | (TextContent | ImageContent)[],
  options?: { deliverAs?: "steer" | "followUp" },
): void
```

The underlying `AgentSession.sendUserMessage(...)` returns a `Promise<void>`, but
`pi.sendUserMessage(...)` is fire-and-forget: asynchronous failures are reported
through the extension error path rather than thrown to the caller. A synchronous
throw can still happen if the extension runtime is inactive/stale.

Behavior:

- Content arrays are normalized to joined text plus optional images.
- Prompt-template and slash-command expansion are disabled for this path
  (`expandPromptTemplates: false`, source `"extension"`). Do not rely on sending
  `/cc ...` or another slash command via `pi.sendUserMessage`; send explicit
  natural-language Command Center framing instead.
- If the session is idle, the message starts a new turn.
- If the session is busy and no `deliverAs` is provided, the underlying prompt
  path errors with: "Agent is already processing. Specify streamingBehavior
  ('steer' or 'followUp') to queue the message." With `pi.sendUserMessage` this
  is reported asynchronously; with replaced-session contexts that expose
  `sendUserMessage(...): Promise<void>`, it rejects.
- `deliverAs: "steer"` queues a steering message for the current turn. Use for
  timely human comments/review notes that should affect the in-flight response.
- `deliverAs: "followUp"` queues a user message to run after the current turn.
  Use for Command Center continuation prompts, rework prompts, or handoff-style
  messages that should start the next model turn after the current one settles.

Adapter rule of thumb:

- If `ctx.isIdle()` is true, call `pi.sendUserMessage(text)` for immediate visible
  driving.
- If `ctx.isIdle()` is false and the message should influence the current answer,
  call `pi.sendUserMessage(text, { deliverAs: "steer" })`.
- If `ctx.isIdle()` is false and the message should be the next role turn, call
  `pi.sendUserMessage(text, { deliverAs: "followUp" })`.
- If neither queued behavior is acceptable, refuse/cancel and ask the user to
  retry when the session is idle.
