# Research 01: How an extension spawns and addresses headless Pi sessions

Ticket: [01-session-spawning-mechanics](../issues/01-session-spawning-mechanics.md) · Status: resolved
Primary sources inspected (2026-08-22):

- `node_modules/@earendil-works/pi-coding-agent@0.84.1` (`.d.ts`, `examples/sdk/`)
- pi docs v0.84.2 at `/nix/store/7apn85hxi0xfybxysx97jp25y6am2dc2-pi-0.84.2/libexec/pi/docs/` (`sdk.md`, `rpc.md`)
- `~/.pi/agent/npm/node_modules/pi-intercom` (v0.11.0, raw TS; note: root `package.json` declares `pi-intercom: ^0.10.0` and bundles it — the installed copy is 0.11.0)
- `command-center/` (read-only inspection)

## TL;DR

A Pi extension spawns headless sessions with **`createAgentSession()`** from `@earendil-works/pi-coding-agent` (in-process, full event stream), or a subprocess via **`pi --mode rpc`** (JSONL protocol). The extension API itself has **no spawn primitive** — an extension that wants actors imports the SDK or spawns a process. Identity for intercom addressing comes from the **Pi session name** (`--name` at spawn / `set_session_name` / `session.setSessionName()`), which pi-intercom mirrors as its presence name. Cross-process observation of actor state reuses **pi-intercom extension channels** (`intercom:extension-register`), the pattern command-center already ships.

## (a) Spawning headless sessions via the SDK

### Entry points

The package exports the SDK from its root (`node_modules/@earendil-works/pi-coding-agent/package.json`, `exports["."]` → `dist/index.d.ts`). Re-exported surface (`dist/index.d.ts`): `createAgentSession`, `createAgentSessionFromServices`, `createAgentSessionServices`, `createAgentSessionRuntime` / `AgentSessionRuntime`, `SessionManager`, `SettingsManager`, `DefaultResourceLoader`, `ModelRuntime`, tool factories (`createCodingTools`, `createReadOnlyTools`, …).

Minimal headless session (`examples/sdk/01-minimal.ts`):

```ts
const { session } = await createAgentSession();
session.subscribe((event) => { /* … */ });
await session.prompt("…");
session.dispose();
```

### Required / optional config

`CreateAgentSessionOptions` (`dist/core/sdk.d.ts`):

| Option | Meaning |
| --- | --- |
| `cwd` | working dir for project-local discovery (default `process.cwd()`) |
| `agentDir` | global config dir (default `~/.pi/agent`) |
| `model` / `thinkingLevel` | `Model` via `getModel("anthropic", "…")` from `@earendil-works/pi-ai`; default from settings |
| `tools: string[]` | **allowlist** — "When provided, only the listed tool names are enabled" |
| `excludeTools: string[]` | denylist, applied after `tools` |
| `noTools: "all" \| "builtin"` | suppression mode when no allowlist |
| `customTools: ToolDefinition[]` | extra tools registered in addition to built-ins |
| `sessionManager` | `SessionManager.inMemory(cwd)` = ephemeral; `SessionManager.create(cwd)` = persisted + auto-resume |
| `settingsManager` | `SettingsManager.inMemory({compaction: …, retry: …})` for overrides |
| `modelRuntime` | auth/models runtime (default uses `agentDir` `auth.json`/`models.json`) |
| `resourceLoader` | supplies extensions/skills/system prompt |

**System prompt**: `createAgentSession` has **no `systemPrompt` option**. Two paths (see `examples/sdk/03-custom-prompt.ts`, `12-full-control.ts`):

1. `new DefaultResourceLoader({ systemPromptOverride: (base) => … })` then pass as `resourceLoader` (doc: pi docs `sdk.md` § System Prompt).
2. Full-custom `ResourceLoader` object with `getSystemPrompt()` (`examples/sdk/12-full-control.ts`).
3. Via services (command-center's path, below): `createAgentSessionServices({cwd, resourceLoaderOptions: {noExtensions: true, systemPrompt}})` — `command-center/core/session.ts` `PiSessionRunner.startOrResume`, with the comment "createAgentSession itself exposes no systemPrompt option".

**Tools per actor**: pass `tools: ["read", "bash"]` for allowlists, plus `customTools` for the graph's `emit` tool. `examples/sdk/05-tools.ts` covers built-in allowlists.

### Lifecycle control

`AgentSession` (`dist/core/agent-session.d.ts`):

- `prompt(text, options?)` — sends a prompt; **resolves when the full accepted run finishes** (pi docs `sdk.md` § Prompting and Message Queueing: "`prompt()` still resolves only after the full accepted run finishes, including retries"). `PromptOptions.streamingBehavior: "steer" | "followUp"` required if already streaming.
- `steer(text)` / `followUp(text)` — queue mid-run steering / post-run follow-ups.
- `sendUserMessage(content, {deliverAs})` — always triggers a turn (extension-side equivalent on `ExtensionAPI`, `dist/core/extensions/types.d.ts` `ExtensionAPI.sendUserMessage`).
- `sendCustomMessage(msg, {triggerTurn, deliverAs})` — inject non-user messages.
- Lifecycle: `abort(): Promise<void>`, `waitForIdle(): Promise<void>`, `dispose()`, getters `isStreaming` / `isIdle` / `isCompacting` / `isRetrying`. Exit detection for a turn = `await prompt()` resolution, or `agent_end`/`agent_settled` events.
- Session replacement: `AgentSessionRuntime` (`dist/core/agent-session-runtime.d.ts`) `newSession()` / `switchSession()` / `fork()` / `importFromJsonl()`; **subscriptions attach to a specific `AgentSession` — re-subscribe after replacement** (pi docs `sdk.md` § createAgentSessionRuntime).

### Subprocess alternative: RPC mode

`pi --mode rpc --no-session` — JSONL over stdin/stdout (pi docs `rpc.md` § Starting RPC Mode). Flags include `--provider`, `--model`, **`--name <name>`** (sets the session display name at startup — the intercom-relevant hook), `--no-session`, `--session-dir`. Commands: `prompt` (with `streamingBehavior`), `steer`, `follow_up`, `abort`, `new_session`, `get_state`, `get_messages`, `set_model`, **`set_session_name`**, `get_session_stats`, `switch_session`, `fork`, `bash`, … Events stream as JSON lines mirroring `AgentSessionEvent` (`rpc.md` § Events). Typed subprocess client: `RpcClient` (exported from the package, `dist/index.d.ts`; source `src/modes/rpc/rpc-client.ts` per `rpc.md`). Caveat: Node `readline` is not protocol-compliant (splits on U+2028/U+2029) — split on `\n` only (`rpc.md` § Framing). pi docs recommend the SDK over RPC when in the same Node process and type safety is wanted (`sdk.md` § RPC Mode Alternative).

`runPrintMode(runtime, {initialMessage, messages})` is the single-shot variant (`sdk.md` § runPrintMode).

## (b) pi-intercom identity & messaging

### Registration & identity

Each pi session with pi-intercom loaded auto-connects: `ensureConnected()` → `spawnBrokerIfNeeded(config.brokerCommand, config.brokerArgs)` → `IntercomClient.connect(buildRegistration(), sessionId)` (`pi-intercom/index.ts`, `ensureConnected`, ~line 1136). The broker is a detached standalone process auto-spawned with a lock file (`pi-intercom/broker/spawn.ts` `spawnBrokerIfNeeded`; `~/.pi/agent/intercom/broker.sock`, `broker.spawn.lock`, exits after 5 s idle — README § How It Works).

**Name**: presence name = `pi.getSessionName()` trimmed; unnamed sessions get a runtime fallback alias `subagent-chat-<sessionId[0..18]>` flagged `runtimeFallbackAlias: true` (`index.ts` `resolveIntercomPresenceName` / `buildPresenceIdentity`, lines 431–444). Presence re-syncs when the name changes (`syncPresenceIdentity`). So **naming a spawned actor "coder-for-task-1" = setting its Pi session name** at spawn time — via `pi --mode rpc --name coder-for-task-1` (`rpc.md`), the `set_session_name` RPC command, or `session.setSessionName("coder-for-task-1")` on the SDK path (`agent-session.d.ts`), or `PI_SUBAGENT_INTERCOM_SESSION_NAME` when spawned under the pi-subagents bridge (`index.ts` env `SUBAGENT_INTERCOM_SESSION_NAME_ENV`).

**Stable ID**: intercom ID = `PI_INTERCOM_STABLE_ID` env > `config.json` `stableId` > pi session ID (`index.ts` `resolveConfiguredIntercomSessionId`). `PI_INTERCOM_STABLE_ID` is per-process, so a spawner can pin each actor's intercom ID across relaunches (config `stableId` is machine-global — README warns "the newest registration takes over that identity").

**Registration payload**: `SessionRegistration` = `{name?, cwd, model, pid, startedAt, lastActivity, status?, contextPct?, contextTokens?, contextWindow?, tmuxPane?, extensions?}`; the broker returns `registered {sessionId, features}` (`pi-intercom/types.ts` `ClientMessage`/`BrokerMessage`).

### Addressing & send/ask/reply semantics (intercom tool, README § Tool Reference)

- `to` = session **name or ID (or unique ID prefix)**; ambiguous duplicate names fail with the IDs listed (`index.ts` `resolveSessionTarget`). `cwd` scopes the lookup; `openProjectPaneIfMissing` opens a visible Herdr pane.
- `send` — fire-and-forget, returns after delivery; infers a reply when the destination has exactly one pending inbound ask; `cancel(messageId)`, `supersedes`, `retryOf` supported.
- `ask` — **client-side blocking**: requires a connected recipient, blocks until reply (default 10 min, `PI_INTERCOM_ASK_TIMEOUT_MS`), reply returned as tool result; one pending ask per session; disconnected target fails immediately (`config.ts` `getAskTimeoutMs`; README § send vs ask).
- `reply` — receiver-side sugar: targets the current inbound ask, falls back to the single unresolved ask, `pending` lists them.
- Delivery to a busy session goes through Pi's steering queue (`sendIncomingMessage` uses `pi.sendMessage(..., {deliverAs: "steer"})`, `index.ts` ~908–928); idle sessions get `{triggerTurn: true}` unless `inboundTrigger` is `replies`/`never` (`shouldTriggerInboundMessage`, `config.ts` `InboundTriggerPolicy`). Messages are rendered inline and persisted in session history as `customType: "intercom_message"` entries.

### Registry / discovery

`intercom({action: "list"})` / `list-cwd` return `SessionInfo[]` (name, short ID, cwd, model, live status, context usage). Programmatic discovery for extensions: `IntercomExtensionChannel.listSessions(): Promise<SessionInfo[]>` (`pi-intercom/extension-api.ts`).

### Spawning sessions via intercom (Herdr path)

`openProjectPane` (`pi-intercom/project-agent.ts`): `herdr pane split --current --direction right --cwd <realpath>` → paneId; `herdr pane run <paneId> '<pi bin>'` (`PI_INTERCOM_PI_BIN` > `PI_BIN` > `"pi"`); then `waitForProjectSession` polls `listSessions()` every 250 ms (20 s timeout) for a **newly registered** session in that cwd — i.e. pi-intercom's own spawn pattern is *visible pane + poll broker registry until the session registers*. Herdr ≥ 0.7.5 required (`supportsRawPanes`).

### pi-subagents bridge (env contract)

If the spawner sets `PI_SUBAGENT_ORCHESTRATOR_TARGET`, `PI_SUBAGENT_RUN_ID`, `PI_SUBAGENT_CHILD_AGENT`, `PI_SUBAGENT_CHILD_INDEX` (+ optional `PI_SUBAGENT_ORCHESTRATOR_SESSION_ID`/`PI_INTERCOM_SESSION_ID`, `PI_SUBAGENT_INTERCOM_SESSION_NAME`), the child gets a `contact_supervisor` tool (`need_decision` blocking, `interview_request` structured blocking, `progress_update` fire-and-forget) targeting the supervisor (`index.ts` `readChildOrchestratorMetadata`, env consts at top of file; README § Subagent-to-Supervisor Escalation).

## (c) Subscribing to a spawned session's state/events

**In-process SDK sessions** — `session.subscribe(listener)` with `AgentSessionEvent` (`dist/core/agent-session.d.ts` `AgentSessionEvent`; base union in `@earendil-works/pi-agent-core/dist/types.d.ts` `AgentEvent`):

- lifecycle: `agent_start`, `agent_end {messages}`, `agent_settled`, `turn_start`, `turn_end {message, toolResults}`
- streaming: `message_start` / `message_update {assistantMessageEvent}` (text_delta, thinking_delta) / `message_end`
- tools: `tool_execution_start {toolCallId, toolName, args}` / `tool_execution_update` / `tool_execution_end {result, isError}`
- session plumbing: `queue_update`, `entry_appended`, `compaction_*`, `auto_retry_*`, `bash_execution_update`

"Idle / thinking / executing" is derived from these (there is no single status event in-process). pi-intercom derives exactly this for presence: `pi.on("agent_start"|"tool_execution_start"|"tool_execution_end"|"agent_end")` → `syncPresenceStatus()` publishing `idle | thinking | tool:<name>` (`index.ts` lines 1448–1477).

**RPC subprocess sessions** — same event types as JSON lines on stdout (`rpc.md` § Events).

**Cross-process (coordinator in another session)** — two mechanisms:

1. **Intercom presence** (`listSessions`/`session_joined`/`session_left`/`presence_update` broker messages, `types.ts`): coarse status only (idle/thinking/tool:name + context %).
2. **pi-intercom extension channels** (`pi-intercom/extension-api.ts`): another extension registers a namespaced channel and receives arbitrary payloads + full session roster events:

```ts
pi.events.emit(INTERCOM_EXTENSION_REGISTER_EVENT /* "intercom:extension-register" */, {
  namespace: "actor-graph/v1",
  ownerEligible: true,
  onReady: (channel) => { /* channel.publish / commitState / listSessions */ },
  onEvent: (event) => { /* message | owner | state | session_joined | session_left | presence_update */ },
});
```

Channel API: `publish(payload ≤ 16 KiB, {audience: "owner"|"capable", ownerOnly})`, `commitState(payload, expectedRevision)` (compare-and-swap, ≤ 64 KiB revisioned state per namespace, one elected owner per namespace), `listSessions()` (`extension-api.ts` `IntercomExtensionChannel`). Channel traffic **never enters a transcript and never triggers a turn** (README § Extension channels) — ideal for progress events. Load-order gotcha: pi-intercom only listens after its own factory runs; it announces `intercom:extension-registry-ready` — re-register on that event if `onReady` hasn't fired (`command-center/extensions/cc.ts` `registerIntercom`, lines ~608–620, with an explanatory comment).

## (d) Injecting an initial prompt / driving a headless session

- **SDK**: `session.prompt(text)` — await full completion; `steer`/`followUp` mid-run; `PromptOptions.preflightResult` tells you whether the prompt was accepted before the run (`sdk.md` § Prompting).
- **RPC**: `{"type": "prompt", "message": "…"}` (+ `streamingBehavior` when streaming); response `success: true` means accepted — events stream asynchronously (`rpc.md` § prompt).
- **Interactive/pane sessions**: `ExtensionAPI.sendUserMessage(text, {deliverAs: "followUp"})` when the target session is busy — exactly what command-center's visible-lead runner does (`command-center/core/session.ts` `VisibleLeadRoleSession.prompt`), and what intercom inbound delivery uses (`pi.sendMessage` steer path).
- **First-prompt injection in a pane**: command-center's Herdr runner launches `pi "<escaped prompt>"` as the pane's initial command, then falls back to `send-text` for follow-ups (`command-center/core/herdr-session.ts` `HerdrRoleSession.prompt`).

## What is reusable vs. what the extension must build itself

### Reusable as-is (public surfaces the extension can rely on)

| Capability | Reuse from | Contract |
| --- | --- | --- |
| Headless session factory + config | `@earendil-works/pi-coding-agent` `createAgentSession` | options incl. `tools` allowlist, `customTools`, `SessionManager.inMemory/create` (`dist/core/sdk.d.ts`) |
| System prompt per actor | `DefaultResourceLoader({systemPromptOverride})` or `resourceLoaderOptions.systemPrompt` via services path (`command-center/core/session.ts` documents the gap) | re-sent every turn, survives compaction (command-center injects Memory this way) |
| Turn lifecycle / events | `session.subscribe` + `AgentSessionEvent` union | `agent_*` / `message_*` / `tool_execution_*`; `prompt()` resolves on completion |
| Actor identity naming | Pi session name at spawn (RPC `--name` / `set_session_name` / SDK `setSessionName`) + pi-intercom mirrors it | presence name = `pi.getSessionName()` (`index.ts` `buildPresenceIdentity`); unique names or ID prefixes for addressing |
| Stable intercom IDs | `PI_INTERCOM_STABLE_ID` env per spawned process | `resolveConfiguredIntercomSessionId` (`index.ts`) |
| Peer discovery + status | pi-intercom broker: `list`/`list-cwd` tool or `channel.listSessions()` | `SessionInfo {id, name, cwd, model, status, contextPct…}` (`types.ts`) |
| Cross-session messaging semantics | `send`/`ask`/`reply`/`pending`/`cancel` | ask = blocking w/ 10-min timeout, reply-as-tool-result (README § Tool Reference) |
| Cross-process event fan-out | pi-intercom **extension channels** (`intercom:extension-register`) | `publish ≤16 KiB`, revisioned state ≤64 KiB, owner election; no transcript pollution (`extension-api.ts`) |
| Spawn-a-visible-session pattern | pi-intercom `openProjectPane` (herdr split + run + poll registry) | only if actors should be visible; not required for headless |
| Supervisor bridge (optional) | pi-subagents env contract (`PI_SUBAGENT_*`) | gives actors `contact_supervisor`; needs pi-subagents installed |

### Command-center patterns worth copying (re-implement, don't import — constraint: never modify command-center, and its core is not a published package)

1. **`SessionRunner` seam** (`command-center/core/session.ts`): `startOrResume(who, cwd, systemPrompt, tools) → RoleSession {sessionId, prompt(), isStreaming(), abort()}` — a narrow, testable interface with a `FakeSessionRunner` for orchestrator tests. Actor-graph should define its own runner seam the same way; note the SDK services recipe inside `PiSessionRunner.startOrResume` (`createAgentSessionServices({cwd, resourceLoaderOptions: {noExtensions: true, systemPrompt}})` + `createAgentSessionFromServices({customTools})`) is the exact wiring needed for "spawn a headless actor with role prompt + emit tool".
2. **Event vocabulary normalization** (`normalizePiEvent`, same file): message_update→message-delta/reasoning-delta, tool_execution_start/end→tool-call-started/ended, message_end(assistant)→message-ended, agent_end→session-ended (turn boundary), skipping content-block plumbing. Actor-graph needs the same thinning for its event schema (Ticket 03).
3. **Memory-in-system-prompt** (`buildSystemPrompt`): append per-actor docs to the system prompt so they survive compaction — free re-injection.
4. **Per-actor cwd = auto-resume**: each role's worktree cwd makes `SessionManager.create(cwd)` resume that role's thread automatically — no explicit session bookkeeping.
5. **Intercom channel fan-out** (`extensions/cc.ts`): every normalized bus event `intercomChannel.publish(normalized, {audience: "capable"})` so other processes (the triggering session's progress view) can observe actor activity; plus the `intercom:extension-registry-ready` re-registration guard for load-order robustness.
6. **Driver lock / single-writer** (`core/driver-lock.ts`): advisory file lock (`wx` write, pid+hostname, stale reclaim) if multiple processes could drive the same graph.
7. **What to avoid**: Herdr/Orca pane runners give **no streaming events** (poll plan status + pane liveness only) and panes are user-closable; the in-process SDK runner is the only one with a full event stream. Command-center also drives the *visible* session for the lead role via `before_agent_start` system-prompt override + `sendUserMessage(followUp)` + `agent_settled` waiters — actor-graph explicitly does NOT reuse the triggering session as an actor (map constraint), so that hybrid is out of scope.

### What the extension must build itself

- **Spawn orchestration**: calling `createAgentSession` per actor (or `pi --mode rpc` subprocesses) from the coordinator extension — including choosing in-process vs subprocess. In-process sessions are simplest and give full event streams, but share the coordinator's process (one crash kills all actors, no isolation); RPC subprocesses give isolation at the cost of JSONL plumbing. Nothing in the SDK/intercom packages provides a "spawn pool" — the runner seam is ours.
- **Actor→intercom naming policy**: set each actor's session name (and/or `PI_INTERCOM_STABLE_ID`) at spawn, and a registry mapping graph nodes → session IDs (intercom `list` gives discovery, not graph topology).
- **Graph event schema + emit tool**: the typed envelope (Ticket 02) and the `emit` tool registered via `customTools`/`registerTool`; channel `publish` is the transport.
- **Channel router / termination counters**: channels `max_iterations`, role `emits` validation — pure coordinator logic.
- **Exit detection for spawned processes** (if subprocess route chosen): RPC has no "process exited" event beyond socket close; the runner must watch child exit + `agent_end`.
- **Progress view wiring**: consuming the channel's `message`/`presence_update` events into the TUI widget (pattern exists in `cc.ts` `liveActivity` phase machine + throttled refresh; re-implement).
