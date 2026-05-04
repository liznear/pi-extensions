# Custom Agents Extension

This extension turns `~/.pi/agent/agents/*.md` into switchable agent profiles.

It replaces the old toggle-based plan mode. Define a `plan` agent profile and switch to it when needed.

## Agent files

Location:

- `~/.pi/agent/agents/*.md`

Each markdown file is one agent.

Frontmatter:

- `name` (required)
- `type` (optional: `primary` or `subagent`; default = `subagent`)
- `allowed_tools` (optional array; omission = no restriction)

Body:

- System prompt template for this agent

Example:

```md
---
name: plan
type: primary
allowed_tools: [read, bash, grep, find, ls, edit_plan]
---

You are in planning mode.
Create and update implementation plans in .pi/plans using edit_plan.
Do not modify source files.
```

## What the extension provides

- `/agent` or `/agent list` — list loaded agents
- `/agent <name>` — switch active primary agent
- `/agent next` — cycle primary agents
- `Alt+P` — cycle primary agents
- `run_subagent` tool — invoke a `type: subagent` agent with isolated context

## Behavior

- On each turn, Pi system prompt building remains normal (skills/tools/context/etc).
- The active agent prompt is appended as hidden context in `before_agent_start`.
- If `allowed_tools` is present, toolset is restricted for that turn.

## Replace old plan mode with a profile

Define a `plan` agent in `~/.pi/agent/agents/plan.md` and switch to it:

```text
/agent plan
```

That gives you plan behavior without a custom mode toggle.
