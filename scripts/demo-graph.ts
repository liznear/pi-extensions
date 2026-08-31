/**
 * bun run demo:graph — scaffold a throwaway demo repo for a live Tier-2 run
 * (RFC §12): git repo + minimal package.json (spike lesson S6 — LLMs
 * hallucinate repo tooling without one) + a planted-omission brief (S9 — the
 * brief omits the critic's code standard, so the revision loop actually fires).
 * Prints the copy-template → pi → /graph run handoff script.
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const name = `graph-demo-${new Date().toISOString().slice(11, 19).replaceAll(":", "")}`
const dir = join(tmpdir(), name)

// spike lesson S5: mkdir before anything spawns
mkdirSync(join(dir, "src"), { recursive: true })
writeFileSync(
	join(dir, "package.json"),
	`${JSON.stringify(
		{
			name: "graph-demo",
			version: "0.1.0",
			private: true,
			scripts: { test: "bun test" },
		},
		null,
		"\t",
	)}\n`,
)
// planted omission: utils.ts has no JSDoc — the critic's standard will demand a revision round
writeFileSync(
	join(dir, "src", "utils.ts"),
	"export function add(a: number, b: number) {\n\treturn a + b\n}\n",
)

const repo = Bun.spawnSync(["git", "init", "-q"], { cwd: dir })
if (repo.exitCode !== 0) {
	console.error(
		"git init failed — worktree mode needs a git repo:",
		repo.stderr.toString(),
	)
	process.exit(1)
}
Bun.spawnSync(["git", "add", "-A"], { cwd: dir })
Bun.spawnSync(["git", "commit", "-qm", "init"], { cwd: dir })

const brief =
	"Extend src/utils.ts with a greet(name) function that returns a friendly greeting, and cover add() with a test in src/utils.test.ts."

console.log(`Demo repo: ${dir}

Next steps (RFC §12 Tier 2):
  1. cp -r ${join(import.meta.dir, "..", "actor-graph", "templates", "review-pipeline")} ~/.pi/graphs/review-pipeline
  2. cd ${dir} && pi
  3. /graph run review-pipeline ${brief}

Expect: coder implements (no JSDoc — the brief omits the standard), critic demands a
revision round, coder fixes + re-emits, then merge → task done.
`)
