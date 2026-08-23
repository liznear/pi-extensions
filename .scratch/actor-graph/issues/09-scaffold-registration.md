# Ticket 09: Scaffold the actor-graph extension

Status: open
Type: task (AFK)
Parent map: [Actor-Graph map](../map.md)

## Question

Scaffold the extension exactly as [actor-graph RFC §14](../../../plans/actor-graph-rfc.md) lays out, so the runner/TUI/tests slices have a home:

1. `actor-graph/` directory with the RFC's layout: `index.ts` (entry), `src/` module stubs (grammar, parser, validator, events, dashboard, session-runner, runner, blackboard, workspace, commands, channel), `tui/widget.ts`, `templates/`, `__tests__/`.
2. Register `actor-graph/index.ts` in root `package.json` under `pi.extensions`.
3. Ship both templates from RFC Appendix A — `templates/review-pipeline.yaml` + `templates/pair.yaml` — **plus their `prompts/*.md`** (coordinator/coder/critic/driver/navigator; each role prompt must carry the MANDATORY-emit paragraph verbatim from the spike's prompts, RFC lesson S2).
4. `/graph` command stubs (run|steer|abort|resume|gc|delete) that parse and acknowledge but do nothing yet.
5. `scripts/demo-graph.ts` + root script `demo:graph` (scaffold a throwaway demo repo per RFC §12 Tier 2).

Acceptance: `bun run verify` green with the scaffold in place; `pi` loads the extension without errors (commands registered).

## Context

- Sizing source: [actor-graph RFC §14](../../../plans/actor-graph-rfc.md) (implementation slices table). Graduated from map fog by [ticket 07](07-spec-rfc.md).
- Small: one session. Blocks 10 (runner), 11 (TUI).
- Constraint: independent extension — never modify command-center; changes stay in this repo (AGENTS.md).
