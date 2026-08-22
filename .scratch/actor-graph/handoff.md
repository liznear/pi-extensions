# Handoff: Message-Driven Actor Graph Extension Design & PoC

## Context & Motivation

The user identified that the existing `command-center` extension is conceptually a specialized instance of Graph Engineering (a fixed Meta-Graph of Lead planning -> Work item execution -> Review/Reject loop -> Merge).
The goal is to design and implement a more generalized graph workflow extension in this repo (`pi-extensions`) that can parse a graph definition and execute arbitrary multi-agent workflows.

## Key Decisions Reached

1. **Destination & Scope**:
   - An independent extension in this repository (`pi-extensions`).
   - Deliverable: Core architectural specification + a minimal, functional PoC (headless session execution) verifying the execution model, with high observability.

2. **Core Computational Model (Message-Driven Actor Graph)**:
   - Built around the Actor model / message passing rather than pure centralized state machines.
   - Nodes can be long-lived actors communicating via messages.
   - Bidirectional communication is supported (e.g. downstream critic sending revisions back to an upstream coder).

3. **Intercom Protocol Reuse (`pi-intercom`)**:
   - Instead of building a custom messaging bus from scratch, the graph runner leverages Pi's existing `pi-intercom` primitive (`send`, `ask`, `reply`).
   - Every actor/session gets a named identity in intercom.

4. **Addressing, Lifecycles & State (Role Profile vs Task Session)**:
   - **Singleton Nodes** (e.g., Planner / Coordinator): Long-lived, persistent context across the whole mission/graph lifecycle.
   - **Per-Task Nodes** (e.g., Coder, Reviewer): Roles defined as static **Role Profiles** (system prompt + tools). When a task is spawned, a fresh, isolated session is instantiated (e.g., `coder-for-task-1`, `reviewer-for-task-1`).
   - All revision loops for Task 1 stay bound to that specific task's session instances, completely avoiding context pollution, state leakage, and routing collisions.
   - **State**: Node-local state (private session + optional worktree) + Shared Blackboard/Global Store (observable by all, broadcast updates).

5. **DSL Representation (YAML/JSON)**:
   - Formulated with distinct sections:
     - `roles`: Prompts, tools, and capabilities.
     - `nodes`: Lifecycle definitions (`singleton` vs `per_task` / `task_pipeline`).
     - `channels` / `flow`: Routing rules, communication scoping (`scoped_to: task`), and state triggers.

## Next Steps for Continuing Agent

1. **Finalize DSL & Architecture Spec**:
   - Produce a concise RFC/Spec (e.g., `plans/actor-graph-rfc.md`) capturing the finalized DSL grammar, lifecycle states, and intercom message protocol.
2. **Scaffold Extension Package**:
   - Create the extension directory (e.g., `pi-graph/` or `graph-runner/`).
   - Register in root `package.json` under `pi.extensions`.
3. **Implement Core PoC**:
   - YAML parser & Graph validator.
   - Headless Session Coordinator using Pi Subagent / Intercom API.
   - Observability layer: Event emission + Console/TUI dashboard tracking node states (`idle`, `thinking`, `executing`) and message flow logs.
4. **Verification**:
   - Add unit tests under `pi-graph/__tests__/`.
   - Run `bun run verify` to ensure zero lint/type/test errors.

## Suggested Skills

- `plan` / `write-plan`: To structure the concrete implementation phases for the PoC.
- `tdd`: For implementing the graph parser, DAG scheduler, and session lifecycle state machines test-first.
- `pi-intercom`: For deep integration with session-to-session messaging primitives.
- `cleanup`: For verifying and formatting after changes are made.
