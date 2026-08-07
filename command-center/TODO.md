# TODO — Command Center

Future work that was consciously deferred. Each item lists what it is, why it's
deferred, what would trigger revisiting it, and where the decision was made.

## PiRPCSessionRunner (RPC-mode runner design)

These surfaced during the wayfinder design effort for replacing the SDK-backed
pi runner with `pi --mode rpc` (`.scratch/pi-rpc-session-runner/map.md`). The v1
design deliberately keeps the surface small; everything below is the v2+ expansion.

### Ordered teardown: `SessionRunner.dispose()`

- **What:** an awaitable `dispose()` on `SessionRunner` that aborts in-flight
  turns, SIGKILLs child pi processes, and unlinks bridge sockets — in order.
- **Why deferred:** v1 self-registers `process.on("exit")` + SIGINT/SIGTERM hooks
  to kill children, which is enough for process exit; the bridge socket is swept
  by the boot-time liveness sweep. No orchestrator or exit-point wiring needed.
- **Revisit when:** coordinated/awaitable shutdown is wanted (e.g. clean test
  isolation, graceful drain on Electron `before-quit`, or a hosted long-running
  server that starts/stops sessions without exiting the process).
- **Decided in:** #05 (Event, error, and shutdown semantics).

### Mid-turn cancellation: `abort` + `RoleSession.cancel()`

- **What:** wire the RPC `abort` / `abort_bash` / `abort_retry` commands and add a
  `cancel()` to `RoleSession` so a runaway turn (looping agent, long bash) can be
  stopped mid-stream.
- **Why deferred:** the SDK runner has no `cancel()` and #03 scoped v1 to
  request/response with no cancellation. A runaway turn still settles or rejects
  (Q2), same as SDK mode.
- **Revisit when:** mid-turn cancellation is required (graduates #03's deferred
  streaming/cancellation, and pairs with streaming tool output below).
- **Decided in:** #05 + #03.

### Streaming tool output

- **What:** forward `tool_execution_update` / `bash_execution_update` (partial
  tool/bash output) onto the event stream instead of dropping them.
- **Why deferred:** v1 reuses `normalizePiEvent` verbatim, which returns null for
  these; matches SDK behavior (no partial tool streaming surfaced).
- **Revisit when:** a CC tool streams via `onUpdate`, or the GUI wants live bash
  output. Also graduates a tool using `signal` for cooperative cancel.
- **Decided in:** #05 + #04.

### Handshake verification: `ready { native, bridge }`

- **What:** after classifying the manifest, the extension reports which tools it
  enabled natively vs registered as forwarders, so the app can assert its coding
  tools weren't accidentally forwarded.
- **Why deferred:** v1 trusts the `pi.getAllTools()` classification (coding tools
  are reliably present in pi).
- **Revisit when:** pi's built-in tool set is less stable, or a hard guarantee is
  needed that coding tools run in-process.
- **Decided in:** #04.

### Loopback TCP transport fallback

- **What:** a TCP impl of the `BridgeTransport` interface for platforms where
  Unix domain sockets are unavailable.
- **Why deferred:** v1 ships the Unix-socket impl behind a thin transport seam;
  TCP is additive.
- **Revisit when:** cross-platform support beyond Unix-socket-capable OSes is
  required.
- **Decided in:** #03.

### Arbitrary consumer-provided tools

- **What:** allow consumers to register their own executable tools at runtime,
  beyond the closed role manifest.
- **Why deferred:** v1 closes the manifest at handshake (exactly the role's
  `ToolDefinition[]`); consumer tools are out of scope of the first RPC design.
- **Revisit when:** consumers need custom tools in the RPC runner.
- **Decided in:** #04 (also the map's Out-of-scope).
