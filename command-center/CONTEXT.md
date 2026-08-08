# Command Center

A library that drives an AI to finish a mission by planning a DAG of work items and
executing them through role-based agent sessions. It streams events a GUI could bind
to; a CLI with a console subscriber proves the stream.

## Language

**Mission**:
A unit of work described in natural language, with objectives, acceptance criteria,
and constraints. The top-level thing the library drives to completion.
_Avoid_: task, job, request

**Mission Lead**:
The role responsible for the mission's success: defines the mission, writes and
updates the Plan, and reviews work items. One per mission.
_Avoid_: orchestrator, manager, planner

**Work Item**:
A single node in a Plan's DAG: a titled, described piece of work with dependencies
on other work items.
_Avoid_: task, ticket, story

**Plan**:
A DAG of Work Items for one Mission, authored and updated by the Mission Lead.
_Avoid_: schedule, roadmap, breakdown

**Work Item Owner**:
The role responsible for executing a single Work Item to completion and signaling
it ready for review. One per work item.
_Avoid_: worker, executor, agent

**Role Profile**:
The static definition of a role: its system prompt and its allowed tools.
_Avoid_: persona, config

**Role**:
An instance of a Role Profile scoped to a Mission (or to a Work Item). Holds
persisted context (Memory) and may run across multiple Agent Sessions, at most one
active at a time. The Mission Lead and each Work Item Owner are Roles.
_Avoid_: actor, bot

**Agent Session**:
A single pi agent invocation \u2014 a "thread." A Role opens a new session or continues
its active one when it receives input. Only one session is active per Role at a time.
_Avoid_: conversation, turn, run

**Drive**:
The act of moving a Mission or Work Item forward through its lifecycle loop. The Orchestrator "drives" a Mission by repeatedly dispatching ready Work Items, and "drives" a Work Item by acquiring the owner's session and prompting it to execute.
_Avoid_: pump, loop, execute

**Orchestrator**:
The reactor, shipped by the library, that dispatches events to Roles, starts Agent
Sessions, and drives the plan-review loop. Constructed with interface dependencies
(Store, etc.) so a consumer can swap implementations.
_Avoid_: scheduler, controller, app

**Memory**:
Per-Role persisted markdown, written via `Store.updateMemory(...)` and auto-loaded
into the Role's session at start. Scoped to a Role instance, not shared across the
Mission.
_Avoid_: context, state, cache

**Event**:
A discrete, streamable fact the library emits (mission defined, plan written, work
item status changed, review requested, message delta, tool call, memory updated).
The subscriber API a GUI binds to.
_Avoid_: message, signal, log

**Worktree**:
A git worktree — an isolated working directory on its own branch — assigned to a Role.
The Mission Lead works in the Integration Worktree; each Work Item Owner works in its
own worktree branched off the integration branch.
_Avoid_: sandbox, checkout, working directory

**Integration Worktree**:
The Mission Lead's worktree, on the integration branch that accepted work items merge
into. Holds the living state of accepted work — what the mission has produced so far.
_Avoid_: main, trunk, base branch

**Acceptance**:
The human sign-off a Mission enters (status `ready_for_acceptance`) once all its work
items are accepted. The human accepts (Mission → completed) or rejects with feedback
(Mission → back to in-progress for the Mission Lead to re-plan).
_Avoid_: approval, sign-off

**Human Input Request**:
A transient, Mission-Lead-authored async question to the human — the lead asks now, the
human answers whenever. Optionally scoped to a Work Item (`workItemId`) and optionally
offering choices (`options`); identified by a unique `requestId`; removed once the lead
consumes the reply.
_Avoid_: prompt, question, ticket

**Message Inbox**:
The persisted per-Mission set of live Human Input Requests
(`missions/<id>/human-input.json`) — the human↔Mission-Lead channel. Holds only requests
still in flight (`open` or `answered`-not-yet-consumed); consumed or mission-end-swept
records are discarded.
_Avoid_: mailbox, queue, channel

**Status Report**:
A Mission-Lead-authored snapshot of where the mission stands, in the lead's own words —
a _narrative_, distinct from the computed Work-Item/Mission status facts (which remain
the source of truth and are never reconciled against it). Filed via the lead-only
`report_status` tool and surfaced as a `status-reported` event; persisted latest-wins
per Mission (`missions/<id>/status.json`) so the human re-sees the current status after
a restart. Removed when the Mission reaches a terminal status.
_Avoid_: progress note, update, log

**Help Request**:
A Work Item Owner's signal that it is blocked _mid-work_ — ambiguous spec, needs a decision,
missing a credential, found a conflict — distinct from `request_review` (which asserts the
item is _done_). Filed via the owner-only `request_help({ reason })`; the Mission Lead
triages and responds via `respond_to_help` (guidance), re-plans, or escalates to a Human
Input Request on the owner's behalf. The item stays `in_progress` (a non-status signal); one
outstanding per item. Not persisted (re-derived on resume); the durable "waiting on the
human" signal, if the lead escalates, is the Human Input Request, not the Help Request.
_Avoid_: escalation, blocker, ticket

**Run**:
One execution of the Orchestrator, from process start to stop. A Mission spans many Runs
across restarts. A Run may drive a Mission only while it holds that Mission's Driver Lock;
explicit commands take the lock over, and a displaced Run stops at its next loop iteration.
_Avoid_: process, instance, invocation

**Driver Lock**:
The cross-process protocol that guarantees a Mission has at most one driver at a time:
a per-Mission advisory lock file (`<storeRoot>/missions/<id>/driver.lock`) recording the
driving Run's pid + hostname. A Run acquires the lock before any drive entry point and
releases it when the drive parks or the Mission terminates. Explicit commands
(`/cc start` / `resume` / `reply` / `accept` / `reject` / `abort` / `delete`) take the
lock over; a displaced driver stops at its next loop iteration. A lock whose holder's pid
is dead (crash) is stale and reclaimable. Read-only commands (`list`, `attach`) don't
drive, but `attach` refuses a Mission another live process is driving.
_Avoid_: mutex, semaphore, lease

**Resume**:
The act of a Run reconstructing the Orchestrator's in-flight view from persisted state and
re-entering the dispatch/plan-review loop — always explicit, never automatic: a Run
resumes because a host called a drive method (`/cc resume`, a human-input reply, an
accept/reject decision), not because a session started. Loop position is _derived_ from
the persisted Mission/Plan (the Work-Item status machine is the checkpoint), never stored
or replayed; a turn interrupted by a crash is re-driven, not replayed.
_Avoid_: restart (a fresh Run with no carried-over state), recover, boot
