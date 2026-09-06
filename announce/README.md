# announce

A pi extension that gives the LLM an `announce` tool to broadcast what it is
currently doing. The latest intention **replaces the built-in `"Working..."`
streaming message** (the spinner is kept), so you can follow along while the
agent works instead of watching it grind through tool calls in silence.

## What it does

- Registers an `announce` tool. The LLM calls it with a one-line summary of
  what it is about to do; the text replaces the `"Working..."` message next to
  the spinner while the agent streams, until it settles or the next user
  prompt arrives (both restore the default message).
- Tool transcript rows stay compact: the call shows `announce <intention>`,
  the result row is empty — the working message is the real output.
- The intention is also mirrored to the **terminal tab title** (`π ◈ <intention>`)
  and restored when the agent settles (see below).
- Two ways to make the LLM actually use it (see below).

## Making the LLM call it

Pi offers three levels, selected via `mode`:

| Mode         | Mechanism                                                                                                                                                                                                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `encourage`  | Tool `promptSnippet` + `promptGuidelines` are injected into the system prompt ("call announce before each batch of work"). Soft only.                                                                                                                                                       |
| `nag`        | Encourage plus a Claude Code-style nag: once more than `nagAfterToolCalls` tool calls have run since the last announce, a short reminder is appended (ephemerally, per request — never persisted to the transcript) to the next LLM request until the model announces. Nothing is blocked.  |
| `enforce`    | Additionally intercepts every other tool call: if the LLM hasn't called `announce` since your last prompt, or has run more than `maxToolCalls` calls since its last announce, the call is **blocked** and the reason is returned to the model, forcing it to announce first.                |
| `off`        | Tool deactivated entirely.                                                                                                                                                                                                                                                                  |

Default is `enforce` with `maxToolCalls: 3`.

## Configuration

Resolved in this order (first match wins):

1. **Env var:** `PI_ANNOUNCE_MODE` — `enforce` / `nag` / `encourage` / `off`
2. **Project-local config:** `<cwd>/.pi/announce.json`
3. **Global config:** `~/.pi/agent/announce.json`
4. Default: `enforce`

Config file shape:

```json
{
 "mode": "nag",
 "nagAfterToolCalls": 3,
 "maxToolCalls": 3
}
```

- `mode` — see table above.
- `maxToolCalls` — in enforce mode, how many tool calls are allowed after each
  announce before the next one is gated (default `3`, clamped to 1–50).
- `nagAfterToolCalls` — in nag mode, how many tool calls may run after an
  announce before the reminder starts being injected into LLM requests
  (default `3`, clamped to 1–50).
- `tabTitle` — set to `false` to stop mirroring the intention to the terminal
  tab title (default `true`).

Project-local config overrides global config.

## Commands

| Command                       | Description                                     |
| ----------------------------- | ----------------------------------------------- |
| `/announce`                   | Show the current configuration.                 |
| `/announce enforce`           | Persist mode `enforce` to the global config.    |
| `/announce nag`               | Persist mode `nag` to the global config.        |
| `/announce encourage`         | Persist mode `encourage` to the global config.  |
| `/announce off`               | Deactivate the tool.                            |
| `/announce clear`             | Restore the default working message.            |

## Tab title mirroring

On every announce, the tab title becomes `π ◈ <intention>` using whatever the
hosting terminal understands:

| Environment                          | Detection            | Mechanism                                    |
| ------------------------------------ | -------------------- | -------------------------------------------- |
| Direct terminal (Orca, iTerm2, Ghostty, WezTerm, Kitty, Windows Terminal, ...) | default | `ctx.ui.setTitle()` — OSC 0 |
| tmux                                 | `$TMUX`              | additionally `tmux rename-window`            |
| GNU screen                           | `$STY` / `TERM=screen*` | additionally `screen -X title`            |

When the agent settles (or on a new prompt / shutdown), the title is restored
to `π - <sessionName> - <folder>` — the same format auto-title uses, so the two
extensions compose. Under tmux, the window's previous `automatic-rename`
setting is captured at session start and restored afterwards.

## Notes

- The working row only appears while pi is streaming; `agent_settled` and the
  next user prompt both restore the default `"Working..."` message so a stale
  intention never leaks into a later turn.
- Related idea: instead of relying on the main LLM to cooperate, an
  auto-title-style background summarizer could infer the intention from the
  message stream. Not implemented — the direct tool is cheaper and precise.
