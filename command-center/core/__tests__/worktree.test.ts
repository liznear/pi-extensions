import { describe, expect, test } from "bun:test"
import { homedir } from "node:os"
import { join } from "node:path"
import {
	integrationBranch,
	integrationWorktreeDir,
	ownerBranch,
	ownerWorktreeDir,
	worktreeRoot,
} from "../worktree/provisioner"

// ---------------------------------------------------------------------------
// Worktree naming (ticket 06 D3) — a pure function of identity (missionId,
// itemId). No random/stateful components. Owner names key off the stable id,
// never the title.
//
//   worktree root        $HOME/.command-center/worktrees/
//   integration branch   cc/<missionId>/integration
//   lead worktree dir    worktrees/<missionId>/integration
//   owner branch         cc/<missionId>/work/<itemId>
//   owner worktree dir   worktrees/<missionId>/work-<itemId>
// ---------------------------------------------------------------------------

describe("worktree naming", () => {
	const repo = "/repo"

	test("worktreeRoot is the global Command Center worktree directory", () => {
		const expected = join(homedir(), ".command-center", "worktrees")
		expect(worktreeRoot(repo)).toBe(expected)
		expect(worktreeRoot("/another-repo")).toBe(expected)
	})

	test("integrationBranch is cc/<missionId>/integration", () => {
		expect(integrationBranch("7k3a9fqa")).toBe("cc/7k3a9fqa/integration")
	})

	test("integrationWorktreeDir is worktrees/<missionId>/integration", () => {
		expect(integrationWorktreeDir(repo, "7k3a9fqa")).toBe(
			join(
				homedir(),
				".command-center",
				"worktrees",
				"7k3a9fqa",
				"integration",
			),
		)
	})

	test("ownerBranch is cc/<missionId>/work/<itemId>", () => {
		expect(ownerBranch("7k3a9fqa", 3)).toBe("cc/7k3a9fqa/work/3")
	})

	test("ownerWorktreeDir is worktrees/<missionId>/work-<itemId>", () => {
		expect(ownerWorktreeDir(repo, "7k3a9fqa", 3)).toBe(
			join(homedir(), ".command-center", "worktrees", "7k3a9fqa", "work-3"),
		)
	})

	test("names are stable/pure (same identity → same name)", () => {
		expect(ownerBranch("7k3a9fqa", 3)).toBe(ownerBranch("7k3a9fqa", 3))
		expect(ownerWorktreeDir(repo, "7k3a9fqa", 3)).toBe(
			ownerWorktreeDir(repo, "7k3a9fqa", 3),
		)
	})

	test("different items / missions produce different names", () => {
		expect(ownerBranch("aaaaaaaa", 1)).not.toBe(ownerBranch("aaaaaaaa", 2))
		expect(ownerBranch("aaaaaaaa", 1)).not.toBe(ownerBranch("bbbbbbbb", 1))
	})
})
