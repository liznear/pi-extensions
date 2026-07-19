# command-run

Batch + step tool runner for pi. Lets the agent invoke several built-in tool
calls — `bash`, `read`, `edit`, `write`, `grep`, `find`, `ls` — in a **single**
tool call, grouped into ordered steps. Independent commands share a step and
run in parallel; commands that depend on earlier side effects use a later step.
All results return together, cutting LLM round-trips, token cost, and latency.

Inspired by Tura's [`command_run`](https://github.com/Tura-AI/tura/blob/main/crates/tools/src/command_run/schema.json)
tool.

## How it works

The extension registers a `command_run` tool. When the model calls it, the
extension dispatches each sub-command directly to fresh built-in tool instances
(`createBashTool`, `createReadTool`, …), grouped by step:

- **Same step → parallel.** Independent read / search / list commands with no
  output dependency on each other share a step and run concurrently.
- **Later step → sequential.** Commands that need earlier side effects
  (write-then-read, mkdir-then-run) use a later unique ordered step.

Per-command output is truncated (80 lines / 4KB), then the aggregate is capped
(1500 lines / 45KB) with a note telling the model where output was cut.

## Parameter shape

```jsonc
{
  "commands": [
    {
      "command_type": "bash",                 // one of: bash|read|edit|write|grep|find|ls
      "parameters": { "command": "rg foo src" },  // MUST match that tool's schema exactly
      "step": 1                               // optional; defaults to 1
    }
    // … up to 20 commands
  ]
}
```

Per-tool `parameters` shapes:

| command_type | parameters                                                                 |
| ------------ | -------------------------------------------------------------------------- |
| `bash`       | `{ command, timeout? }`                                                    |
| `read`       | `{ path, offset?, limit? }`                                                |
| `edit`       | `{ path, edits: [{ oldText, newText }] }`                                  |
| `write`      | `{ path, content }`                                                        |
| `grep`       | `{ pattern, path? }`                                                       |
| `find`       | `{ path?, pattern? }`                                                      |
| `ls`         | `{ path }`                                                                 |

## Example

> "Read package.json, list src/, and check git status" — one tool call instead
> of three:

```jsonc
{
  "commands": [
    { "command_type": "read", "parameters": { "path": "package.json" }, "step": 1 },
    { "command_type": "ls",   "parameters": { "path": "src" },           "step": 1 },
    { "command_type": "bash", "parameters": { "command": "git status" }, "step": 1 }
  ]
}
```

A dependent follow-up (`git add` then `git commit`) goes in a second step:

```jsonc
{
  "commands": [
    { "command_type": "bash", "parameters": { "command": "git add -A" },   "step": 1 },
    { "command_type": "bash", "parameters": { "command": "git commit -m" }, "step": 2 }
  ]
}
```

## Caveats (inherent to in-process batching)

- **No per-sub-command hooks.** Sub-commands are dispatched directly to built-in
  tool instances, so `tool_call` / `tool_result` hooks from other extensions
  (permission gates, audit logging, path protection, …) do **not** fire for
  individual sub-commands — only the top-level `command_run` call is intercepted
  as normal. If you rely on a permission gate, keep those operations as separate
  top-level tool calls.
- **Built-in overrides not respected.** If another extension overrides e.g.
  `read`, those overrides are not used here; sub-commands always run against the
  stock built-in implementations.
- **Image results are flattened.** A `read` on a PNG returns a `[image]` marker
  rather than the actual image content.
- **Output is truncated.** See the limits above; re-run the individual tool if
  you need full output.

## Install

This extension is part of the `pi-extensions` bundle. See the repo README for
package or symlink install instructions.
