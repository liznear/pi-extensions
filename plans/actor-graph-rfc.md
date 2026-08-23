# Actor-Graph Extension RFC

| | |
| --- | --- |
| **Status** | Consolidated spec — decisions frozen from wayfinder tickets 01–06 + spike 08; §15 open questions are **surfaced, not decided** |
| **Effort** | [.scratch/actor-graph/map.md](../.scratch/actor-graph/map.md) (wayfinder) |
| **Sources** | [01 spawning](../.scratch/actor-graph/issues/01-session-spawning-mechanics.md) · [02 envelope](../.scratch/actor-graph/issues/02-intercom-envelope-mapping.md) · [03 grammar](../.scratch/actor-graph/issues/03-channel-grammar-validation.md) ([final grammar](../.scratch/actor-graph/research/03-channels-grammar-final.md)) · [04 state/workspace](../.scratch/actor-graph/issues/04-blackboard-workspace-isolation.md) · [05 events](../.scratch/actor-graph/issues/05-event-schema-prototype.md) ([prototype/](../.scratch/actor-graph/prototype/)) · [06 acceptance](../.scratch/actor-graph/issues/06-example-graph-acceptance.md) · [08 spike](../.scratch/actor-graph/issues/08-spike-execution.md) ([poc/](../.scratch/actor-graph/poc/)) |
| **Verify** | `bun run verify` (biome + tsc + bun test) from repo root |

## 1. Summary & scope

An **independent Pi extension in this repo** (never modifying command-center) that parses a graph YAML from `~/.pi/graphs/` and executes it as headless, intercom-addressed actor sessions — generalizing command-center's fixed Meta-Graph into a message-driven actor graph. The triggering session is never an actor; it becomes a read-only progress view.

**In scope (v1)**: declarative channel routing with typed message envelopes; per-type emit quotas as the only loop protection; task-scoped actor pipelines with lazy spawn; worktree/shared workspace modes; derived blackboard; gap-free event stream + TUI progress widget; run lifecycle (abort/resume/gc/delete); two shipped templates; two-tier acceptance.

**Out of scope (from the map)**: multi-graph parallelism; dispatch escape hatch (dynamic per-message addressing, C-model); modifying command-center; LLM-generated dynamic graphs; per-role model selection (roles use the runner's default model — grammar as resolved has no `model:` field; see OQ6).

## 2. Runtime architecture

```
trigger pi session (human)
 ├─ extension "actor-graph" loaded
 │   ├─ /graph commands (run | steer | abort | resume | gc | delete)
 │   ├─ GraphRunner (in-process; the routing/stamping engine — no LLM)
 │   │   ├─ ActorSessionRunner seam ── PiSessionRunner (services path)
 │   │   │     └─ actor sessions: createAgentSessionFromServices(...)
 │   │   │          coder-for-t1 · critic-for-t1 · coordinator · …
 │   │   ├─ channel router (quotas, lazy spawn, iteration counters)
 │   │   ├─ blackboard (derived view) → runs/<run-id>/blackboard.json
 │   │   └─ EventLog → runs/<run-id>/events.jsonl + intercom channel publish
 │   └─ progress widget (TUI, same process — replays/reduces the event stream)
 └─ pi-intercom: presence mirroring + extension channel "actor-graph/v1" (observation plane)
```

- **Topology (ticket 02)**: actors are spawned **in-process** via the SDK services path; message delivery is in-process function calls. Intercom is the **observation plane**, not the bus — actor identities mirror into intercom presence via Pi session names (`coder-for-task-1`); progress events fan out cross-process over the pi-intercom extension channel. Accepted fault domain: coordinator (runner) dies → graph dies; recovery is `/graph resume`.
- **SessionRunner seam (ticket 01)** — re-implemented from command-center's pattern, never imported:

  ```ts
  interface ActorSessionRunner {
    startOrResume(opts: {
      actorName: string      // Pi session name — stable identity, intercom-mirrored
      role: RoleDef          // systemPrompt, tools allowlist, customTools injection
      cwd: string            // per-actor cwd ⇒ SessionManager.create auto-resumes transcripts
    }): Promise<RoleSession> // { sessionId, prompt(), steer(), sendCustomMessage(), isStreaming(), subscribe(), waitForIdle(), abort(), dispose() }
  }
  ```

  Implementations: `PiSessionRunner` (services path, below) and `FakeSessionRunner` (Tier-1 harness, ticket 06).
- **Spawn recipe (spike-proven, [poc/runner.ts](../.scratch/actor-graph/poc/runner.ts))**:

  ```ts
  const services = await createAgentSessionServices({
    cwd,
    resourceLoaderOptions: { noExtensions: true, systemPrompt: role.systemPrompt },
  })
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.create(cwd),   // persisted, resumable (ticket 02 §5)
    tools: [...role.tools, "emit"],                // ⚠ allowlist filters customTools — lesson S1
    customTools: [emitTool, /* createTaskTool?, completeTaskTool? */],
  })
  session.setSessionName(actorName)
  ```

  System prompt injection path is required because `createAgentSession` itself has no prompt option (ticket 01). Graph-context type-level view (§5) is appended to the role prompt by the runner.
- **Intercom channel** (ticket 05): publish every event to extension channel namespace `actor-graph/v1` (`intercom:extension-register`, `ownerEligible: true`), with the `intercom:extension-registry-ready` re-registration guard (command-center pattern, re-implemented). Channel traffic never enters transcripts, never triggers a turn, ≤16 KiB per publish — which is why events carry `payload_preview ≤ 200 chars`, never full payloads.

## 3. Graph grammar (YAML)

Authoritative grammar: [research/03-channels-grammar-final.md](../.scratch/actor-graph/research/03-channels-grammar-final.md). Normative points:

```yaml
# ~/.pi/graphs/<graph-id>.yaml   (graph id = filename stem; `graph:` field is display metadata)
version: 1

roles:
  <role>:
    system_prompt: |            # or system_prompt_file: prompts/<file>.md (resolved
      …                         #   relative to the graph file's directory)
    tools: [read, bash, …]      # allowlist for built-in tools
    disable_graph_context: bool # opt out of type-level context injection (default false)
    can_create_tasks: bool      # gates create_task tool injection (default false, R14)
    emits:
      - type: <msg_type>
        max_per_task: <N>       # optional per-(role, type, task) quota; omit = free exchange
    receives: [<msg_type>, …]

nodes:
  - role: <role>                # single-role group
    lifecycle: singleton        # eagerly spawned at graph start
  - roles: [<role>, …]
    lifecycle: per_task         # registered "planned" at create_task; spawned lazily (R12/R13)
    owner: <role>               # worktree mode only: receives complete_task (R16)

channels:
  - id: <unique>
    from: <role>                # ⚠ or pseudo-role "runner" — OQ1, pending
    to: <role> | [<role>, …]    # explicit multicast; ⚠ or "runner" — OQ1
    when: msg.type == <literal> # v1 whitelist: msg.type literal comparisons only (R3)
    scoped_to: task | graph     # graph-scope targets must be singletons (R13)

workspace:
  mode: worktree | shared
  task_complete_type: <msg_type>   # shared mode only: message type marking task terminal
```

- **Roles/nodes**: `singleton` = one session per graph run (eagerly spawned at start). `per_task` = one session per `(role, task)` (`coder-for-task-1`), registered in `planned` state at `create_task`, physically spawned lazily on the first message routed to it (R13).
- **Pipelines**: a `per_task` node group is a pipeline. `create_task` registers **all** `per_task` node groups for the minted task; each group's actors spawn lazily and independently (clarification of ticket 03 §3 — confirm in OQ4).
- **Worked examples**: both shipped templates are in Appendix A; the grammar research's merger-based example remains illustrative, but the **canonical** review-pipeline is ticket 06's (merger optional; coder is `owner` calling `complete_task`).

## 4. Validator (load-time, static)

Rules R1–R16 exactly as in the [final grammar](../.scratch/actor-graph/research/03-channels-grammar-final.md) (R6 obsolete-struck). Error UX is line-precise:

```
<file>:<line>:<col> [<rule>] message
review-pipeline.yaml:14:7 [R4] channel 'review' forwards 'pr_ready' but role 'coder' does not declare it in emits
review-pipeline.yaml:31:3 [R11] channel 'review2' conflicts with 'review': same from 'coder', overlapping when-value 'pr_ready'
```

`/graph run` refuses to start on any validation error; Tier-1 item 2 exercises every rule on mutated fixtures.

## 5. Message envelope & the emit tool

**Envelope (ticket 02)** — actor fields + runner stamps:

```ts
// actor-declared (emit tool arguments)
{ msg_id: ulid, type: "pr_ready", task_id: "task-1", payload: "…" }
// runner-stamped at routing time (anti-forgery)
{ sender: "coder-for-task-1", role: "coder", channel: "revise", iteration: 2 }
```

The envelope **physically lacks address fields** — no `to`, no `reply_to`. "Replying" = emitting a new message that goes through normal channel matching. This is the boundary that keeps routing declarative (the dispatch escape hatch stays post-v1).

**Emit tool** — the only structured exit from an actor; registered per-actor via `customTools`. Parameters `{type, task_id, payload}` (payload = short summary; large objects live in workspace files and messages carry **paths, not content**). Failure modes return **in-turn tool errors** (the convergence mechanism):

- `undeclared_type` — type not in the role's `emits`.
- `quota_exhausted` — per-(role, type, task) counter exceeded `max_per_task`; error text guides convergence, e.g. `"pr_ready" 已用完 3 次（任务 task-1）。请停止重试：简要总结当前状态后结束你的回合。`
- `no_matching_channel` — see OQ2 (statically unreachable for validated graphs under current R1).

**Role prompts must name and mandate emit** (spike lesson S2: `promptSnippet` is dead under a replaced system prompt). Template prompts in Appendix A carry the MANDATORY-emit paragraph verbatim from the spike.

**Graph context injection (ticket 02 §6)**: by default the runner appends a **type-level upstream/downstream view** to each role's system prompt (message types ↔ roles, never instance names), via template variables. `disable_graph_context: true` opts a role out entirely.

## 6. Routing semantics & actor lifecycle

1. **Matching**: one emit matches **at most one** channel (R11 forbids ambiguity statically); delivery goes to every `to` entry (explicit multicast; one `message_delivered` event per recipient).
2. **Delivery**: runner calls `sendCustomMessage({customType: "graph_message", content, details: envelope}, {triggerTurn: !busy, deliverAs: busy ? "steer" : undefined})` — verified transcript-persistent (ticket 02 §4). Busy recipients receive via Pi's steer queue (native backpressure).
3. **Quotas**: counted per `(role, type, task)` — i.e. per actor instance. At quota the emit tool errors in-turn; the loop must converge **inside** the conversation. No watchdog, no edge counters: legal loop length is task-intrinsic (pair programming rounds), which is why `max_iterations` was cut.
4. **Iteration counters**: per `(channel, task)`, incremented **only on back-edge traversal** (back-edges statically derived via topo sort; forward channels always report 0). `message_routed.iteration` carries it; `iteration_max` denormalizes the routed type's `max_per_task` when present (dashboard self-sufficiency).
5. **Lazy spawn**: first message routed to `<role, task_id>` with no session yet → runner spawns it (`actor_spawned` follows `actor_planned`). `scoped_to: graph` channels never lazy-spawn (R13).
6. **Stall detection** *(decided here; delegated by spike lesson S7)*: an actor turn that ends without emit is a protocol violation. When **all actors are idle, nothing is in flight, and the run is not terminal**, the runner fails the graph: `graph_failed` with a stall error (short debounce, spike used 250 ms). This is failure-fast protocol enforcement — **not** the rejected loop watchdog.
7. **Graceful drain** *(decided here; delegated by spike lesson S8)*: on terminal settle, the runner awaits in-flight turns (`waitForIdle()` with a bounded timeout) before disposing sessions, so final actor states don't freeze as `thinking/executing`; then `actor_exited {reason: "disposed"}`.
8. **Graph completion**: the run completes when **all created tasks are terminal** (done/failed) and nothing is in flight — after drain, `graph_completed`. Quota-exhausted loops are a **clean** terminal (spike: `exhausted → graph_completed`), not a failure. *(Confirm in OQ5.)*

Node state vocabulary: `planned → spawned → idle | thinking | executing → exited`, with task-done semantics layered on per-task actors.

## 7. Runner-provided tools & commands

| Surface | Who gets it | Semantics |
| --- | --- | --- |
| `emit({type, task_id, payload})` | every actor session | §5; rides the tools allowlist (lesson S1) |
| `create_task(payload)` | `can_create_tasks: true` roles only (R14) | mints `task_id`, registers all per_task node groups `planned`; worktree mode also branches the task worktree |
| `complete_task()` | pipeline `owner` role, worktree mode only (R16) | atomic merge into integration tree — §8 |
| `/graph run <id> [brief…]` | trigger session | validate + start; kickoff delivery ⚠ OQ3 |
| `/graph steer <actor> <text>` | trigger session | `session.steer()`; **actor-name autocomplete** over live actor list (ticket 02 §5) |
| `/graph abort` | trigger session | dispose sessions, mark `aborted`, retain everything |
| `/graph resume <run-id>` | trigger session | rebuild from blackboard + event log (§9) |
| `/graph gc [--days N]` | trigger session | clean completed runs older than N days (default 60) |
| `/graph delete <run-id>` | trigger session | full cleanup (integration tree + worktrees + runs dir) |

Tools are injected via `customTools` at spawn — they are **physically absent** from non-graph sessions. `/graph steer` exists only in the trigger session.

**Kickoff (proposed — OQ3)**: `/graph run` eagerly spawns singletons and delivers the human brief as a runner-synthesized `graph_message` to **every singleton** (`message_emitted.via: "synthesized"`, sender `runner`), mirroring the spike's kickoff. `can_create_tasks` singletons then mint tasks; singleton-less entry (not exercised by either template) would consume the brief directly.

## 8. Workspace, integration, blackboard

**Workspace modes (ticket 04)** — `workspace.mode: worktree | shared`:

```
worktree mode                          shared mode
repo/                                  repo/
└─ runs/<run-id>/integration/  ← runner-created at start; serialized integration
   ├─ runs/<run-id>/task-1/     ← task worktree, branched at create_task from
   ├─ runs/<run-id>/task-2/        the CURRENT integration state
```

- **worktree**: `create_task` branches a task worktree from latest integration state (parallel execution, serialized integration). `complete_task` (owner-only) attempts the atomic merge: **success = task done** (blackboard update + synthesized `task_done` message + `task_done` event); **conflict = in-loop tool error** ("integration has moved; resolve and complete again") with `merge_conflicted` event (files listed) — conflict handling is an actor cycle, same convergence philosophy as quotas. Task worktrees are deleted immediately after successful merge; failed/incomplete ones retained.
- **shared**: no isolation, no `complete_task`; task terminal = a declared `task_complete_type` message (R15).
- **Run artifacts location**: ⚠ **conflict surfaced (OQ7)** — ticket 04's text says `~/.pi/graphs/runs/<run-id>/`, the grammar addendum and spike use project-local `runs/<run-id>/` (worktrees must live in the repo anyway). RFC recommendation: **project-local `<cwd>/runs/<run-id>/`**; graph definitions stay in `~/.pi/graphs/`. Pending confirmation.

**Blackboard (ticket 04)**: runner-held, persisted to `runs/<run-id>/blackboard.json`. Content = structured task state only (tasks table: id / status / assigned / payload summary). It is a **pure materialized view of the message flow** — actors have **no write tools** in v1; every state change traces to a message. Consequently the dashboard and blackboard can never disagree. Actor read access: **none in v1** (recommended default for OQ6) — actors see received messages + the type-level graph context; the blackboard is for humans, resume, and the widget.

**Retention (ticket 04)**: everything retained until explicit delete; auto-GC on graph start for runs completed >60 days; `/graph gc [--days N]` manual.

## 9. Run lifecycle — abort / resume

- **Abort**: sessions disposed (transcripts already persisted per-actor via `SessionManager.create`), state marked `aborted`, all artifacts retained.
- **Resume** (`/graph resume <run-id>`): rebuild runner state from `blackboard.json` + `events.jsonl` (gap-free `seq` = replay cursor; every frame is replay — proven by the prototype demo). Re-spawn surviving actors (transcripts auto-resume via per-actor cwd). In-flight semantics deliberately simple (user-locked): an emit already in the event log is processed; un-emitted work is lost. **No exactly-once in v1.** No `graph_resumed` event — resume continues the same log; re-spawns mark it via `actor_spawned`.

## 10. Event schema v1

Normative source: [prototype/events.ts](../.scratch/actor-graph/prototype/events.ts) — lifts verbatim into `actor-graph/src/events.ts`; the reducer [prototype/dashboard.ts](../.scratch/actor-graph/prototype/dashboard.ts) lifts with it.

**Envelope on every event**: `{v: 1, seq, ts, run_id, graph_id}` — `seq` run-local, **gap-free, monotonic** ⇒ total order, dedup, resume cursor.

**23 types / 6 families** (spike-replayed on real events, ticket 08):

| Family | Types |
| --- | --- |
| graph | `graph_started {workspace_mode, graph_file}` · `graph_completed` · `graph_failed {error}` · `graph_aborted {by}` |
| task | `task_created {task_id, by, summary}` · `task_done {task_id, via: complete_task \| task_complete_type, msg_id?}` · `task_failed {task_id, error}` |
| actor | `actor_planned {actor, role, task_id}` · `actor_spawned {actor, role, task_id?, session_id, cwd}` · `actor_busy` · `actor_idle` · `actor_tool {tool, phase, ok?, detail?}` · `actor_exited {reason}` |
| message | `message_emitted {msg_id, msg_type, task_id?, payload_preview≤200, actor, role, via: emit \| synthesized}` · `emit_refused {…, reason, quota?, error}` · `message_routed {msg_id, task_id?, channel, iteration, iteration_max?}` · `message_delivered {msg_id, to, delivery: triggered \| steered}` (one per recipient) |
| integration | `worktree_created` · `worktree_deleted` · `merge_attempted` · `merge_succeeded {commit, duration_ms}` · `merge_conflicted {files, error, duration_ms}` |
| intervention | `steer_sent {actor, text_preview≤200}` |

**Correlation**: stable ids in bodies (`actor` = Pi session name, `msg_id`, `task_id`); **all views derived** — message traversal = `emitted → routed → delivered` per recipient (stage-split by decision: stuck-between-stages must be visible live); blackboard state derived from task + message events — **no blackboard-mutation events by design**. Runner event-ordering rule (spike lesson S3): log delivery events **before** `sendCustomMessage` (which resolves only after the full turn).

**Consumption surfaces** (ticket 05): ① in-process reducer (the runner's own widget when trigger session = runner process); ② append-only `runs/<run-id>/events.jsonl` (evidence bundle; resume + late viewers replay); ③ pi-intercom extension channel `actor-graph/v1` (cross-process fan-out).

**Deliberately NOT carried** (the consciously drawn line): full message payloads · blackboard mutations · streaming/reasoning deltas · per-actor context/token usage (intercom presence has it) · anything multi-run · cost/latency accounting. Full text always reachable in actor transcripts (`pi --resume`); the widget surfaces a per-actor resume hint.

## 11. Progress TUI contract

Custom widget in the trigger session rendering the event stream through the lifted reducer (target mock: [prototype README](../.scratch/actor-graph/prototype/README.md)). Input priority: in-process emitter → channel `actor-graph/v1` → `events.jsonl` replay (on `/graph resume`). Presentation rules (settled in ticket 05 review): quota-bearing loop channels only in the iteration line; exited actors stay, dimmed, for post-mortem; per-actor resume hint. `/graph steer` autocomplete rides the live actor list.

## 12. Acceptance (ticket 06)

**Tier 1 — the bar, automated in `bun run verify`** via `FakeSessionRunner` (no real LLMs), both templates:

1. graph loads from `~/.pi/graphs/`; both templates validate clean
2. validator rules R1–R16 fire with line-precise errors on mutated fixtures
3. revision loop iterates and terminates at quota (emit tool errors in-turn; refusal event logged)
4. lazy spawn: first routed message to `<role, task>` spawns the session; `planned` registered at `create_task`
5. merge conflict → in-loop tool error → resolution → `merge_succeeded` + `task_done` on a self-generated fixture repo
6. event stream matches schema v1 (types, envelope, gap-free seq, stage-split message flow)
7. abort mid-run → `/graph resume` → replayed blackboard/event state matches pre-abort
8. `/graph gc --days N` and `/graph delete` clean up run artifacts

**Tier 2 — the demo, manual**: one real-LLM `review-pipeline` run in a real pi session, watched live (`bun run demo:graph` scaffolds a generated throwaway repo — planted-omission task design per spike lesson S9 — and prints next steps: copy template → `pi` in demo repo → `/graph run review-pipeline`).

**Deliberately NOT proven**: LLM convergence quality under quota pressure · cross-process intercom fan-out (trusted from command-center) · coordinator crash recovery (accepted fault domain) · 60-day auto-GC timing (only `/graph gc --days N` exercised).

## 13. Spike lessons → normative requirements

| # | Lesson (ticket 08) | RFC requirement |
| --- | --- | --- |
| S1 | `tools` allowlist filters `customTools` too | runner always passes `[...role.tools, "emit", …gated]` (§2 recipe) |
| S2 | `promptSnippet` dead under replaced system prompt | role prompts name + mandate emit (Appendix A wording) |
| S3 | `sendCustomMessage({triggerTurn:true})` resolves after the full turn | log delivery events before the call (§10) |
| S4 | `agent_end` + `agent_settled` both fire; settle is the reliable idle signal | reducer keys idle on `agent_settled`; dedupe (§6) |
| S5 | Bun `spawnSync` with nonexistent cwd → misleading `ENOENT '/bin/sh'` | mkdir before spawn; fixture scaffolding creates dirs first |
| S6 | LLMs hallucinate repo tooling | demo repo carries a minimal `package.json` grounding actors |
| S7 | Turn-end-without-emit stall is cheaply detectable | stall detection = fast-fail (§6.6), distinct from the rejected watchdog |
| S8 | Disposing mid-drain freezes final actor states | graceful drain before dispose (§6.7) |
| S9 | Planted contradiction → debate loop; omission → fix loop | Tier-2 demo task uses an omission (§12) |

## 14. Extension layout & implementation slices

```
actor-graph/
  index.ts              # entry: register /graph commands, intercom channel, widget
  src/
    grammar.ts          # GraphDef types (roles/nodes/channels/workspace)
    parser.ts           # YAML load, line/col-preserving (validator needs positions)
    validator.ts        # R1–R16, line-precise errors
    events.ts           # schema v1 (lifted from prototype/events.ts)
    dashboard.ts        # reducer (lifted from prototype/dashboard.ts)
    session-runner.ts   # ActorSessionRunner seam + PiSessionRunner + FakeSessionRunner
    runner.ts           # router, quotas, lazy spawn, lifecycle, stall/drain, EventLog
    blackboard.ts       # derived view + persistence
    workspace.ts        # integration tree, task worktrees, complete_task merge
    commands.ts         # /graph run|steer|abort|resume|gc|delete (+steer autocomplete)
    channel.ts          # intercom channel publish (actor-graph/v1)
  tui/widget.ts         # progress widget (trigger session)
  templates/
    review-pipeline.yaml · pair.yaml · prompts/*.md
  __tests__/            # Tier-1 harness (FakeSessionRunner)
scripts/demo-graph.ts   # bun run demo:graph
```

Registration: root `package.json` → `pi.extensions += ["actor-graph/index.ts"]`. Built-in templates ship with the extension but are **zero runtime dependency** (copied to `~/.pi/graphs/` by the user; the extension never requires them).

**Sizing (graduates the map's fog as tickets 09–12; OQ cluster as ticket 13)**:

| Ticket | Slice | Size | Blocked by |
| --- | --- | --- | --- |
| [09 scaffold & registration](../.scratch/actor-graph/issues/09-scaffold-registration.md) | extension skeleton, root registration, templates + prompts, `/graph` stubs, verify green | ~1 session, small | — |
| [10 runner implementation](../.scratch/actor-graph/issues/10-runner-implementation.md) | parser → validator → session seam (+fake) → router/tools/quotas → blackboard/workspace/merge → lifecycle (abort/resume/gc/delete) → channel publish; TDD per slice | ~3–4 sessions, large | 09, 13 |
| [11 TUI progress widget](../.scratch/actor-graph/issues/11-tui-progress-widget.md) | lifted reducer + widget + steer autocomplete; develop against events.jsonl replay | ~1 session, medium | 09 |
| [12 tests & acceptance run](../.scratch/actor-graph/issues/12-tests-acceptance.md) | Tier-1 items 1–8 in `bun run verify`; `demo:graph` scaffold + story | ~1–2 sessions, medium | 10, 11 |
| [13 runner-facing semantics (grilling)](../.scratch/actor-graph/issues/13-runner-facing-semantics.md) | OQ1–OQ7 below, one at a time | ~1 session, HITL | — |

Runner-internal order: parser/validator are pure and land first (unblocks Tier-1 item 2); the session seam + fake unblock everything else; workspace/merge last (only worktree mode needs it).

## 15. Open questions (surfaced, not decided)

No new decisions were made in this RFC beyond the two explicitly delegated by ticket 08 (§6.6 stall, §6.7 drain). Everything below goes to one grilling ticket ([proposed as ticket 13](../.scratch/actor-graph/issues/13-runner-facing-semantics.md)):

| OQ | Gap / conflict | Recommendation |
| --- | --- | --- |
| OQ1 | **Runner-consumed message types** — R2 says `from`/`to` reference declared *roles*, but the runner mints (kickoff, `task_done`) and consumes (`lgtm`-style terminals, `task_complete_type`) messages. The spike used pseudo-role `__runner__` in channels and it worked. | Formalize pseudo-role **`runner`** in `from`/`to`; R1 exempts types consumed by a `to: runner` channel. Templates in Appendix A are written with it. |
| OQ2 | `emit_refused.reason: "no_matching_channel"` is statically unreachable under R1 (every declared type must have a channel). | Keep the enum value (defensive, free) but document unreachability for validated graphs; or relax R1. |
| OQ3 | **Kickoff delivery** — how the human brief enters the graph was never pinned. | Deliver as runner-synthesized message to all eagerly-spawned singletons (§7). |
| OQ4 | **Multiple per_task pipelines** — does `create_task` register all groups? Grammar says "the pipeline's" (singular). | Register **all** per_task node groups per task; groups spawn independently (§3). |
| OQ5 | **Graph completion semantics** — when is the whole run done (all tasks terminal? coordinator decides?). | All created tasks terminal + nothing in flight → drain → `graph_completed` (§6.8). |
| OQ6 | **Blackboard read access for actors** (ticket 04 left it "TBD-simple") and per-role `model:` selection (absent from grammar). | No read API in v1 (messages + graph context only); no per-role model in v1 (runner default). |
| OQ7 | **Runs directory location** — ticket 04 text: `~/.pi/graphs/runs/…`; grammar addendum + spike: project-local `runs/<run-id>/`. | Project-local `<cwd>/runs/<run-id>/` (worktrees live in the repo anyway; `.gitignore`-able). |

## Appendix A: shipped templates

### review-pipeline.yaml (canonical — Tier 2 target)

```yaml
graph: review-pipeline
version: 1

workspace:
  mode: worktree

roles:
  coordinator:
    system_prompt_file: prompts/coordinator.md
    tools: [read, bash]
    can_create_tasks: true
    emits:
      - type: task_assigned
    receives: [task_done]          # synthesized task_done flows here — OQ1

  coder:
    system_prompt_file: prompts/coder.md   # mandates emit (lesson S2)
    tools: [read, write, edit, bash, ls, find, grep]
    emits:
      - type: pr_ready
        max_per_task: 3
    receives: [task_assigned, revision]

  critic:
    system_prompt_file: prompts/critic.md
    tools: [read, bash, ls, find, grep]
    emits:
      - type: revision
        max_per_task: 3
      - type: lgtm
    receives: [pr_ready]

nodes:
  - role: coordinator
    lifecycle: singleton
  - roles: [coder, critic]
    lifecycle: per_task
    owner: coder                    # R16 — complete_task lands here

channels:
  - {id: assign, from: coordinator, to: coder,     when: msg.type == task_assigned, scoped_to: task}
  - {id: review, from: coder,       to: critic,    when: msg.type == pr_ready,     scoped_to: task}
  - {id: revise, from: critic,      to: coder,     when: msg.type == revision,     scoped_to: task}
  - {id: done,   from: runner,      to: coordinator, when: msg.type == task_done,  scoped_to: task}   # OQ1

workspace_task_terminal: complete_task    # worktree mode — owner's merge is the terminal
```

### pair.yaml (the counter-example template)

```yaml
graph: pair
version: 1

workspace:
  mode: shared
  task_complete_type: pair_done

roles:
  coordinator:
    system_prompt_file: prompts/coordinator.md
    tools: [read, bash]
    can_create_tasks: true
    emits:
      - type: task_assigned
    receives: [pair_done]
  driver:
    system_prompt_file: prompts/driver.md
    tools: [read, write, edit, bash, ls, find, grep]
    emits:
      - type: question          # free exchange — no quotas by design
      - type: handoff
    receives: [task_assigned, answer, handoff]
  navigator:
    system_prompt_file: prompts/navigator.md
    tools: [read, bash, ls, find, grep]
    emits:
      - type: answer
      - type: handoff
      - type: pair_done         # task_complete_type — emitted when the pair concludes
    receives: [question, handoff]

nodes:
  - role: coordinator
    lifecycle: singleton
  - roles: [driver, navigator]
    lifecycle: per_task          # shared mode: no owner, no complete_task

channels:
  - {id: assign,    from: coordinator, to: driver,    when: msg.type == task_assigned, scoped_to: task}
  - {id: ask,       from: driver,      to: navigator, when: msg.type == question,      scoped_to: task}
  - {id: answer,    from: navigator,   to: driver,    when: msg.type == answer,        scoped_to: task}
  - {id: hand_fwd,  from: driver,      to: navigator, when: msg.type == handoff,       scoped_to: task}
  - {id: hand_back, from: navigator,   to: driver,    when: msg.type == handoff,       scoped_to: task}
  - {id: conclude,  from: navigator,   to: runner,    when: msg.type == pair_done,     scoped_to: task}  # OQ1
```

Differing on every axis: quotas vs none, revision loop vs free exchange, worktree vs shared, `complete_task` vs `task_complete_type`.

*(The `workspace_task_terminal` line in review-pipeline is documentation of R15's mechanism, not a grammar field — worktree-mode terminal is `complete_task` by definition; a cleaner phrasing may fall out of OQ1.)*
