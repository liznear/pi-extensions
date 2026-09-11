# annotate

Interactive code review and feedback annotation in Pi, powered by [revdiff](https://revdiff.com).

## Features

- **Native Terminal Diff Review**: Syntax highlighting, add/remove colors, hunk navigation, blame, and intra-line word-diff.
- **Three Review Targets**:
  - `/annotate last` — Annotate the agent's latest assistant response or plan.
  - `/annotate diff` — Annotate git diff against `HEAD` including untracked files.
  - `/annotate diff <base>` — Annotate git diff against any branch or tag (e.g. `main`).
  - `/annotate <path>` or `/annotate @<path>` — Annotate a standalone file or directory.
- **Feedback Loop**: Annotations made in the TUI are captured on exit and sent directly back to the agent as the next user message.

## Requirements

Requires the `revdiff` binary on your `PATH`.
Install with Homebrew:

```bash
brew install umputun/apps/revdiff
```

Or configure via environment variable:

```bash
export REVDIFF_BIN=/path/to/revdiff
```
