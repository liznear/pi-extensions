# auto-correct

Automatically detects when a user message is a correction to the AI's previous behavior and persists the learning into `AGENTS.md`.

## How it works

1. On every `agent_end` event, extracts the last 2 user-assistant turns and checks whether the previous run was aborted.
2. Sends this focused context to an LLM with a detection prompt that classifies whether the user message is a correction.
3. If it is a correction, the LLM also extracts an actionable learning rule.
4. The learning is appended to `AGENTS.md` under a `## Auto-Learnings` section (creating the file if it doesn't exist).

## Context sent to the LLM

The LLM receives three pieces of context to decide if a correction occurred:

### 1. Last 2 turns of conversation

Instead of sending the entire session history, only the last 2 complete turns are serialized:

| Turn | Messages included |
|---|---|
| **Turn N-1** (previous) | User prompt → Assistant response (including tool calls, tool results, and final text) |
| **Turn N** (current) | User prompt (potential correction) → Assistant response |

This gives the LLM exactly what it needs: what the user originally asked, what the assistant did, and whether the user's follow-up is correcting it. Earlier turns are irrelevant for correction detection.

### 2. Abort signal

A boolean indicating whether the **previous** agent run was aborted by the user (Ctrl+C / cancel). An abort is a strong signal that the assistant's output was unsatisfactory, making the next user message more likely to be a correction.

This is tracked across `agent_end` events using module-level state:
- On each `agent_end`, the current run's abort status (`ctx.signal.aborted`) is saved.
- On the next `agent_end`, the saved value is passed to the detection LLM as context.

### 3. System prompt (hard-coded)

The detection prompt (`DETECTION_SYSTEM_PROMPT`) instructs the model to classify corrections vs. non-corrections and extract a learning. It also notes that an aborted previous run increases the likelihood of a correction.

### Detection criteria

The model classifies a message as a correction if the user:

- Points out something the AI did wrong or suboptimally
- Tells the AI to do something differently
- Provides feedback that the output was incorrect
- Asks the AI to fix or redo something
- Clarifies requirements the AI misunderstood

And **not** a correction if the user is:

- Asking a new question
- Providing new instructions for a new task
- Simply continuing the conversation
- Giving positive feedback

## Output

When a correction is detected, an `## Auto-Learnings` section in `AGENTS.md` is updated with the extracted rule. If the section already exists, the new learning is prepended under it. If `AGENTS.md` does not exist, it is created with a default header and the learning.
