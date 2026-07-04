# otty-integration

Report pi agent state to the [Otty](https://otty.app) terminal app so an Otty
pane can show the processing / idle badge and fire its "Task complete"
notification. Mirrors Otty's bundled opencode / claude / codex integrations.

## What it does

Spawns Otty's bundled CLI on state transitions:

```text
pi event       → otty-cli call
-----------------------------------
session_start  → state:idle
agent_start    → state:processing
agent_end      → state:idle
```

Otty matches each terminal pane to its process tree via `agent-pid`, so the
badge tracks the right pane even when multiple agents share a directory.

## Install

This extension is part of the `pi-extensions` bundle. Install the whole bundle:

```bash
pi install git:github.com/<owner>/pi-extensions
```

Or symlink just this extension for local development:

```bash
mkdir -p ~/.pi/agent/extensions
ln -sfn "$PWD/otty-integration" "$HOME/.pi/agent/extensions/otty-integration"
```

Then restart pi or run `/reload`.

## The `pi` kind caveat

Otty's bundled `otty-cli` only accepts three agent kinds:

```text
error: Invalid agent: pi. Expected: claude, codex, opencode
```

So this extension reports `opencode` by default. Functionally this is fine:
Otty matches panes by pid, so a real opencode pane and a pi pane are never
conflated. The only effect is cosmetic (the badge may read "opencode").

When Otty ships a `pi` kind, set `OTTY_KIND=pi` to switch over with no code
change:

```bash
export OTTY_KIND=pi
```

## Configuration (env)

| Variable     | Default                                              | Purpose                                                          |
| ------------ | ---------------------------------------------------- | ---------------------------------------------------------------- |
| `OTTY_KIND`  | `opencode`                                           | Agent kind reported to otty-cli (`claude` / `codex` / `opencode`; `pi` once Otty supports it). |
| `OTTY_CLI`   | `/Applications/Otty.app/Contents/MacOS/otty-cli`     | Absolute path to the otty-cli binary.                            |
| `OTTY_SOCKET`| macOS default `~/Library/Application Support/io.appmakes.otty/otty.sock` | Otty IPC socket path, forwarded to otty-cli.         |

If the otty-cli binary or its IPC socket is not found (e.g. Otty isn't
running), the extension silently no-ops — it never breaks your pi session.

## Status command

```text
/otty
```

Reports the current kind, last reported state, and whether the Otty socket is
reachable.
