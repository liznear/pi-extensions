# auto-title

A pi extension that automatically sets a short, descriptive session title after
your first prompt — so the session selector shows something meaningful instead
of the raw first message.

Title generation runs **entirely in the background**: the `before_agent_start`
handler returns immediately and the model call is fired off asynchronously, so
your normal agent workflow is never blocked.

## What it does

- On your **first** prompt of a session, generates a 3–8 word title from the
  prompt text and sets it via `pi.setSessionName()`.
- Only runs once per session instance (resets on `/new`, `/resume`, `/fork`,
  `/reload`).
- Skips sessions that already have a name (e.g. resumed/`--name` sessions).
- Uses a configurable model (see below). Falls back to the active session model.
- Mirrors the session name to the **terminal tab title**, so it shows up in the
  host terminal's tab bar — including Orca's embedded terminal, iTerm2, Ghostty,
  WezTerm, etc. (via the standard OSC title sequence; no Orca-specific code).
  Orca's auto tab title follows this OSC title; a manual title (UI rename or
  `orca terminal rename --title`) pins the label over it — session
  classification is unaffected, but live updates stop showing. Reset a pinned
  tab with `orca terminal rename --terminal <handle>` (omit `--title`).

## Configuration

The model used for title generation is resolved in this order (first match wins):

1. **Env var:** `PI_AUTO_TITLE_MODEL` — value is `provider/modelId`
   (e.g. `anthropic/claude-haiku-4-5`, `openai/gpt-5.2-mini`)
2. **Project-local config:** `<cwd>/.pi/auto-title.json`
3. **Global config:** `~/.pi/agent/auto-title.json`
4. **Active session model** (`ctx.model`)

Config file shape:

```json
{
  "model": "anthropic/claude-haiku-4-5",
  "maxLength": 50,
  "enabled": true
}

```

- `model` — `provider/modelId`. Omit to use the active session model.
- `maxLength` — hard cap on title length (default `50`).
- `enabled` — set to `false` to disable auto-titling entirely.

Project-local config overrides global config.

## Commands

| Command         | Description                                                                |
| --------------- | -------------------------------------------------------------------------- |
| `/title`        | Set a custom title (`/title <text>`), or regenerate from first message.    |
| `/title-model`  | Pick the model used for title generation (persisted to global config).     |
| `/title-config` | Show the resolved configuration.                                           |

`/title-model` lists only models with auth configured
(`ctx.modelRegistry.getAvailable()`).

## Install in this repo

This repo auto-discovers extension directories. After linking/syncing, this
extension is available at `~/.pi/agent/extensions/auto-title`. Restart pi or run
`/reload`.

## Environment variable

| Variable              | Format              | Example                       |
| --------------------- | ------------------- | ----------------------------- |
| `PI_AUTO_TITLE_MODEL` | `provider/modelId`  | `anthropic/claude-haiku-4-5`  |
