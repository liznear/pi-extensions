---
name: mini-task
description: Context management via structured mini-tasks. Use mini_task_start to explicitly state your plan and begin tracked work, mini_task_handoff to compress context when done, mini_task_tree to orient. Break large tasks into mini-tasks. Experiments are mini-tasks too. Use this where there are multiple steps, one step needs to collect a lot of information to draw the final conclusion, and only the conclusion is useful for following steps.
---

# Mini-Task: Structured Context Management

Your context window is limited. Mini-tasks give you **explicit control** over when context is compressed.

**Core idea:** A top-level ask may requires multiple steps, and some steps may require a lot of information to draw the final conclusion. However, the final conclusion is the most useful piece of information for following steps. Instead of including all these information in context, this tool wraps every focused unit of work in a mini-task. When done, hand off — the entire conversation range is replaced by a concise summary. In this way, only important information is kept in context.

## Prerequisites

Mini-task management is enabled by default. The user can toggle it off and on using the `/mini-task` and `/mini-task off` commands.

## The Three Tools

| Tool | Purpose | When |
|------|---------|------|
| `mini_task_start` | Start a tracked task with a save point. Reminds you to explicitly state your plan. | Before beginning any focused work |
| `mini_task_handoff` | Complete task, compress context into summary | When the task's goal is met (or abandoned) |
| `mini_task_tree` | Show task tree and active stack | When you need to orient yourself |

## Workflow

### 1. Start

```javascript
mini_task_start({
  title: "Implement user authentication",
  description: "Add JWT auth with login/logout endpoints"
})
```

This creates a save point. Everything from here until handoff is "inside" this task.

### 2. Work

Execute the task normally using any tools you need.

### 3. Handoff

```javascript
mini_task_handoff({
  summary: "Implemented JWT auth with login, logout, and token refresh endpoints. All 8 tests passing.",
  files_changed: ["src/auth.ts", "src/routes.ts", "tests/auth.test.ts"],
  decisions: ["Used RS256 for JWT signing", "Token expiry: 15min access, 7d refresh"],
  next_step: "Add role-based authorization middleware to protected routes"
})
```

After handoff:
- All conversation from task start to now is **compressed** into a summary
- Context window is freed
- The `next_step` becomes your immediate action
- If nested, the parent task resumes automatically

## Nesting

Mini-tasks can be nested. The default behavior is to nest under the current active task:

```javascript
// Start parent task
mini_task_start({ title: "Refactor database layer" })

  // Start sub-task (auto-nested under parent)
  mini_task_start({ title: "Design new schema" })

  // ... work on schema ...

  // Handoff sub-task → returns to parent task
  mini_task_handoff({
    summary: "Designed normalized schema with users, orders, products tables",
    next_step: "Implement migration script based on the new schema"
  })

  // Continue parent task (schema summary is in context)

// Eventually handoff parent
mini_task_handoff({
  summary: "Refactored DB layer with new schema, migrations, and updated queries",
  next_step: "Update API endpoints to use new data models"
})
```

**Nesting rule:** When a child hands off, the parent resumes. The parent's start point is untouched — only the child's range is compressed.

## Experiments as Mini-Tasks

Experiments, research, and exploration consume context without producing "final" work. Always wrap them:

```javascript
mini_task_start({ title: "Benchmark JSON parsers" })

// ... run benchmarks, collect data, analyze ...

mini_task_handoff({
  summary: "Benchmarked 3 parsers. simdjson fastest (2.1M ops/s). Selected for integration.",
  findings: "simdjson: 2.1M ops/s, rapidjson: 1.4M ops/s, nlohmann: 0.8M ops/s",
  decisions: ["Use simdjson for parsing", "Fallback to rapidjson on unsupported platforms"],
  next_step: "Integrate simdjson into the parser pipeline"
})
```

## Decision Matrix

| Situation | Action |
|-----------|--------|
| Starting focused work | `mini_task_start` |
| Task goal achieved | `mini_task_handoff` with summary |
| Experiment/research | Wrap in mini-task, handoff with findings |
| Feeling lost in the conversation | `mini_task_tree` to orient |
| Large task with clear sub-goals | Nest mini-tasks |
| Context getting long (>50%) | Check for un-handoff'd tasks |
| Abandoned approach | `mini_task_handoff` with failure summary |

## Handoff Message Quality

The `summary` and `next_step` are your lifeline — the compressed context replaces everything you did. Include:

- **What was accomplished** (specific outcomes, not "worked on X")
- **Files changed** (critical for not re-doing work)
- **Key decisions** (so you don't revisit them)
- **Next step** (specific, actionable — what should happen immediately)

Good summary:
```
"Implemented OAuth2 with PKCE flow. Google + GitHub providers working. 12 tests passing. Created auth/oauth.ts, modified routes.ts and config.ts."
```

Bad summary:
```
"Done with auth."
```

## Common Patterns

### Implementation Task

```
mini_task_start → code → test → mini_task_handoff
```

### Research/Spike

```
mini_task_start → explore → analyze → mini_task_handoff (with findings)
```

### Debugging

```
mini_task_start → reproduce → diagnose → fix → verify → mini_task_handoff
```

### Failed Approach

```
mini_task_start → try approach → fails 3 times → mini_task_handoff (with failure analysis and alternative to try)
```

### Multi-Phase Feature

```
mini_task_start (feature)
  mini_task_start (phase 1) → handoff
  mini_task_start (phase 2) → handoff
  mini_task_start (phase 3) → handoff
mini_task_handoff (feature complete)
```
