# Design: Mini-Task Planning & Granularity Optimizations

## 1. The `mini_task_plan` Tool

To address the issue where the agent doesn't plan ahead for what mini-tasks it needs, we will introduce a new tool: `mini_task_plan`.

### Tool Schema & Description

- **Name**: `mini_task_plan`
- **Description**: "Plan a list of mini-tasks for the current session. Always overwrites the existing plan. Can be called at any point to update/refine the upcoming steps based on new information."
- **Parameters**:
  - `tasks`: An array of task plans, where each task plan contains:
    - `id`: Unique, short slug identifier (e.g. `read-configs`, `implement-auth`).
    - `title`: Short descriptive title of the task.
    - `description`: Detailed description of the task goals and success criteria.
    - `depends_on`: Optional list of task `id`s this task depends on (to help express parent/child or sequential relationships).

### Behavior & Integration

- Since it always overwrites, calling it lets the agent easily refine the plan.
- The plan will be rendered in the Dashboard/Tree output (`mini_task_tree` and `/mini-task` UI) under a new section: "Planned Tasks" or integrated within the tree.
- When `mini_task_start` is called, if the title/slug matches a planned task, it transitions that planned task into an "active" task.

---

## 2. Granularity & Shared-Context Optimization

Currently, an agent might start a very small mini-task, read a file, and immediately hand off, leading to unnecessary context compression overhead and redundant file-reads (since multiple tasks might need the same file).

### The Solution: "Shared Pre-reads / Shared Context"

We want to guide the agent to perform **pre-requisite shared operations** (like reading files, gathering schema info, inspecting logs) **before** diving into a sequence of small mini-tasks, and explicitly allow caching/sharing this context.

We will achieve this by:

1. **Adding instructions/rules to `SKILL.md` and tool descriptions**:
   - Guide the agent to read shared resource files *before* spawning multiple mini-tasks that need them.
   - Example: "If multiple upcoming mini-tasks require examining the same file or resource, read/inspect that resource first in the parent context. This shares the context across all child tasks and avoids redundant reads."
2. **Expanding the `mini_task_plan` capability**:
   - Allow a plan to specify `shared_pre_reads` (list of files/endpoints to inspect first) or generic `shared_context` notes.
3. **Registering the `mini_task_plan` tool in `mini-task/index.ts`**.
