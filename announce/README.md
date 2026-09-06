# announce

A pi extension that gives the LLM an `announce` tool to broadcast what it is
currently doing. The latest intention is rendered as a widget **above the input
box**, so you can follow along while the agent works instead of watching it
grind through tool calls in silence.

## What it does

- Registers an `announce` tool. The LLM calls it with a one-line summary of
  what it is about to do; the text shows up above the editor until the agent
  settles (or the next user prompt clears it).
- Tool transcript rows stay compact: the call shows `announce <intention>`,
  the result row is empty — the widget is the real output.
- Two ways to make the LLM actually use it (see below).

## Making the LLM call it

Pi offers two levels, selected via `mode`:

| Mode        | Mechanism                                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `encourage` | Tool `promptSnippet` + `promptGuidelines` are injected into the system prompt ("call announce before each batch of work"). Soft only. |
| `enforce`   | Additionally intercepts every other tool call: if the LLM hasn't called `announce` since your last prompt, or has run more than `maxToolCalls` calls since its last announce, the call is **blocked** and the reason is returned to the model, forcing it to announce first. |
| `off`       | Tool deactivated entirely.                                                                                                            |

Default is `enforce` with `maxToolCalls: 3`.

## Configuration

Resolved in this order (first match wins):

1. **Env var:** `PI_ANNOUNCE_MODE` — `enforce` / `encourage` / `off`
2. **Project-local config:** `<cwd>/.pi/announce.json`
3. **Global config:** `~/.pi/agent/announce.json`
4. Default: `enforce`

Config file shape:

```json
{
 "mode": "enforce",
 "maxToolCalls": 3
}
```

- `mode` — see table above.
- `maxToolCalls` — in enforce mode, how many tool calls are allowed after each
  announce before the next one is gated (default `3`, clamped to 1–50).

Project-local config overrides global config.

## Commands

| Command                      | Description                                    |
| ---------------------------- | ---------------------------------------------- |
| `/announce`                  | Show the current configuration.                |
| `/announce enforce`          | Persist mode `enforce` to the global config.   |
| `/announce encourage`        | Persist mode `encourage` to the global config. |
| `/announce off`              | Deactivate the tool.                           |
| `/announce clear`            | Clear the intention widget.                    |

## Notes

- `agent_settled` clears the widget once the agent is fully done (including
  retries and follow-ups); a new user prompt also clears it immediately.
- Related idea: instead of relying on the main LLM to cooperate, an
  auto-title-style background summarizer could infer the intention from the
  message stream. Not implemented — the direct tool is cheaper and precise.
