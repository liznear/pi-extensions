# Plan Mode Extension

A focused planning mode that restricts file modifications to `.pi/plans/` folder.

## Features

- **Controlled file edits**: Only the `edit_plan` tool can modify files, and only in `.pi/plans/`
- **Date-prefixed naming**: Plan files are automatically named `<yyyy-mm-dd>-<feature-name>.md`
- **Bash allowlist**: Only read-only bash commands are allowed
- **Session persistence**: State survives session resume

## Commands

- `/plan` - Toggle plan mode
- `/plans` - List all plan files in `.pi/plans/`
- `Alt+P` (Option+P on macOS) - Toggle plan mode (shortcut)

## CLI Flag

```bash
pi --plan    # Start in plan mode
```

## Usage

1. Enable plan mode with `/plan` or `--plan` flag
2. Explore the codebase using read-only tools (read, bash, grep, find, ls)
3. Create a plan using the `edit_plan` tool:

```
action: create
feature_name: add-user-authentication
content: |
  # Add User Authentication

  ## Overview
  Implement JWT-based authentication for the API.

  ## Tasks
  1. Create user model
  2. Add login/logout endpoints
  3. Implement middleware for protected routes
```

4. The plan is saved to `.pi/plans/2024-01-15-add-user-authentication.md`

## edit_plan Tool Actions

| Action | Description | Required Parameters |
|--------|-------------|---------------------|
| `list` | List all plan files | none |
| `read` | Read a plan file | `filename` |
| `create` | Create a new plan | `feature_name`, `content` |
| `update` | Update an existing plan | `filename`, `content` |

### Optional Parameters

- `append: true` - Append content to existing plan instead of replacing (for `update` action)

## File Naming Convention

Plans are automatically named with a date prefix:

```
.pi/plans/
├── 2024-01-15-add-auth.md
├── 2024-01-15-refactor-database.md
├── 2024-01-16-update-api-docs.md
└── 2024-01-17-fix-logging.md
```

## Bash Command Allowlist

Safe commands (allowed):
- File inspection: `cat`, `head`, `tail`, `less`, `more`
- Search: `grep`, `find`, `rg`, `fd`
- Directory: `ls`, `pwd`, `tree`
- Git read: `git status`, `git log`, `git diff`, `git branch`
- Package info: `npm list`, `npm outdated`, `yarn info`
- System info: `uname`, `whoami`, `date`, `uptime`

Blocked commands:
- File modification: `rm`, `mv`, `cp`, `mkdir`, `touch`
- Git write: `git add`, `git commit`, `git push`
- Package install: `npm install`, `yarn add`, `pip install`
- System: `sudo`, `kill`, `reboot`
- Editors: `vim`, `nano`, `code`

## Why edit_plan Instead of write/edit?

Using a custom `edit_plan` tool provides:

1. **Security by design** - Restrictions are enforced at the schema level
2. **Clearer UX** - LLM sees one focused tool for plan management
3. **Helpful features** - Auto-naming, listing, appending
4. **No accidental modifications** - Can't accidentally edit source files
