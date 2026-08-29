# Ticket 09: Scaffold the actor-graph extension

Status: resolved (2026-08-29)
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

## Answer

**Scaffolded and green.** `bun run verify` passes with the extension in place: biome check ✓, tsc ✓ (tsconfig `include` extended with `actor-graph` + `scripts`), 308 tests ✓ including 15 new scaffold smoke tests (`actor-graph/__tests__/scaffold.test.ts`); entry module loads and exports the extension default.

Delivered per RFC §14:

1. `actor-graph/` with all 11 `src/` module stubs (grammar types + session seam interfaces are real; parser/validator/runner/blackboard/workspace/channel/dashboard throw "not implemented" with ticket pointers), `tui/widget.ts` placeholder, `README.md`.
2. Registered `actor-graph/index.ts` in root `package.json` `pi.extensions`.
3. Both templates shipped with all 5 role prompts; every prompt carries the spike's MANDATORY-emit paragraph (S2), guarded by tests.
4. `/graph` stub live: run|steer|abort|resume|gc|delete parse args + acknowledge via `ctx.ui.notify`; usage on unknown/missing args.
5. `scripts/demo-graph.ts` + `bun run demo:graph`: scaffolds `runs/demo-graph-<ts>/` (git repo, minimal package.json per S6, repo-conventions README grounding the critic), prints the RFC §12 handoff story with a planted-omission brief (S9).

### ⚠ Two template deviations from RFC Appendix A (route to ticket 13)

R1 (no orphan emits) / R5 (receives must be deliverable) exposed two latent bugs in the RFC's templates as-written; shipped fixed:

- **review-pipeline**: RFC Appendix A leaves critic's `lgtm` with no consuming channel → R1 violation. Shipped: `approve` channel critic→coder (lgtm), `coder.receives` += lgtm; coder prompt: on lgtm call `complete_task` (owner merge), the only turn allowed to end without emit.
- **pair**: coordinator `receives: [pair_done]` but the conclude channel delivered only to `runner` → R5 violation. Shipped: `conclude` multicasts `to: [coordinator, runner]`.

Both need RFC Appendix A correction + rule-exemption wording folded into OQ1's resolution (ticket 13).

### Notes

- Pre-existing repo drift fixed to keep verify green (verify was red at HEAD via commit 2bcf407):
  - `mini-task/index.ts`: format-only fixes (spaces → tabs) plus two type-level repairs: dropped the redundant `expandPromptTemplates: true` (SDK default per `agent-session.js`), replaced the anonymous `as unknown as` cast with a typed `as SessionManager` narrowing + SAFETY comment (`branchWithSummary` is public API; the extension view is deliberately `ReadonlySessionManager`).
  - `tsconfig.json`: removed four decorative comments so the strict-JSON gate passes (JSONC is valid for tsc but the gate doesn't special-case it).
