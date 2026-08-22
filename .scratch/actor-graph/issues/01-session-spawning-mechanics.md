# Ticket 01: How does an extension spawn and address headless Pi sessions?

Status: resolved
Type: research
Parent map: [Actor-Graph map](../map.md)

## Question

Concretely, how does a Pi **extension** (not a user, not the TUI) programmatically:

1. **Spawn headless sessions** on demand — the SDK/API surface (e.g. pi-coding-agent SDK, `@earendil-works/pi-coding-agent` in this repo's devDependencies), what a session needs (agent config, model, system prompt, tools allowlist), and lifecycle control (start, stop, detect exit).
2. **Give each session a stable intercom identity** (e.g. `coder-for-task-1`) — how pi-intercom registration works for a spawned headless session vs. a normal interactive session, and whether sessions can be named/renamed at spawn time.
3. **Drive and observe them** — how to inject an initial prompt, how `send`/`ask`/`reply` reach a headless session, and how to subscribe to a session's state/events (idle / thinking / executing, tool calls, completion) from the coordinating extension.
4. **Reuse patterns already proven in this repo** — command-center already runs herdr/headless session runners; document the exact contracts it relies on (without modifying command-center), and note what is reusable vs. what the new extension must build itself.

Primary sources: pi SDK docs/types in `node_modules/@earendil-works/pi-coding-agent`, `pi-intercom` package (root `dependencies`), command-center sources (`command-center/`), and pi's own docs if present locally. Every claim needs a source citation (file path + symbol).

## Context

- Blocked downstream: the envelope mapping (Ticket 02) and state/workspace isolation (Ticket 04) both need to know what intercom actually supports for spawned sessions.
- Findings file: save as `research/01-session-spawning.md` in this repo (create `research/` under the effort dir, i.e. `.scratch/actor-graph/research/01-session-spawning.md`), then resolve this ticket per the tracker convention (`## Answer` + `Status: resolved` + map pointer).

## Answer

Spawn headless actors in-process via `createAgentSession()` from `@earendil-works/pi-coding-agent` (options: `cwd`, `model`, `tools` allowlist, `customTools`, `SessionManager.inMemory()`; system prompt via `resourceLoaderOptions.systemPrompt` on the services path — `createAgentSession` has no prompt option), or as `pi --mode rpc --name <id>` subprocesses. Identity = the Pi session name set at spawn (intercom presence name mirrors `pi.getSessionName()`; `PI_INTERCOM_STABLE_ID` pins IDs); `send`/`ask`/`reply` reach busy actors via steer/followUp queueing. Observation: in-process `session.subscribe` (agent/message/tool_execution events) with cross-process fan-out over pi-intercom **extension channels** (`intercom:extension-register`, `publish` ≤16 KiB, revisioned state, `listSessions()`). command-center's reusable contracts: `SessionRunner`/`RoleSession` seam, `normalizePiEvent` vocabulary, memory-in-system-prompt, per-actor-cwd auto-resume, channel fan-out with `intercom:extension-registry-ready` re-registration guard.

Full findings with citations: [research/01-session-spawning.md](../research/01-session-spawning.md)

## Comments

- Charting session note: the planned `/research` subagent could not be fired at chart time (no `type: subagent` agent registered on this machine, no suitable intercom peer). Research to be executed in a dedicated session — or directly authorized by the user in the driving session.
