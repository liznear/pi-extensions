# Mini-Task Extension

Context management via structured mini-tasks for the [Pi](https://github.com/earendil-works/pi) coding agent.

## Overview

Mini-task lets the LLM explicitly break work into focused tasks. When a task completes, the entire conversation range is compressed into a summary via tree branching, freeing context window space.

### Key Features

- **Explicit task boundaries** — The LLM consciously starts and ends tasks via tools
- **Context compression** — Handoff replaces task conversation with a concise summary
- **Nested tasks** — Sub-tasks compress independently; parent tasks resume automatically
- **Experiment tracking** — Research and exploration are first-class tasks with findings
- **Visual dashboard** — `/mini-task` command shows task tree with status and nesting

## Installation

### As a local extension

Copy or symlink the `mini-task/` directory to your extensions folder:

```bash
# Global (all projects)
cp -r mini-task/ ~/.pi/agent/extensions/mini-task

# Or project-local
cp -r mini-task/ .pi/extensions/mini-task
```

### As a pi package

```bash
pi install /path/to/mini-task
```

## Usage

### 1. Enable (once per session)

In the Pi TUI, run:

```
/mini-task
```

This enables tree navigation and shows the dashboard.

### 2. LLM-driven task management

The LLM uses three tools:

| Tool | Purpose |
|------|---------|
| `mini_task_start` | Start a tracked task with a save point |
| `mini_task_handoff` | Complete task, compress context into summary |
| `mini_task_dashboard` | Show task tree and active stack |

### Example Flow

```
LLM: mini_task_start({ title: "Implement user auth" })
LLM: ... implements auth ...
LLM: mini_task_handoff({
  summary: "JWT auth with login/logout endpoints, 8 tests passing",
  files_changed: ["src/auth.ts", "src/routes.ts"],
  next_step: "Add role-based middleware"
})
→ Context compressed, LLM continues with next_step
```

## Architecture

### State Persistence

- **In-memory**: Task stack (active tasks on current branch)
- **Session**: Custom entries (`mini-task-start`, `mini-task-complete`)
- **Labels**: Tags mark task start points in the conversation tree

### Context Compression Flow

1. `mini_task_handoff` generates enriched summary
2. `SessionManager.branchWithSummary()` creates a branch from the task start
3. After the agent turn ends, `navigateTree()` switches to the compressed branch
4. A continuation message is injected for the LLM to resume

### Nesting

Child tasks compress independently. When a child hands off:
- The child's conversation is replaced by its summary
- The parent task resumes with the child's summary in context
- The parent's start point remains untouched

## Companion Skill

The extension auto-discovers its companion skill (`mini-task`) which teaches the LLM:
- When to create mini-tasks
- How to structure handoff messages
- Nesting patterns
- Using experiments as mini-tasks

## License

MIT
