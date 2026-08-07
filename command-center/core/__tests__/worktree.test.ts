import { describe, expect, test } from "bun:test"
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
//   worktree root        <repo>/.command-center/worktrees/   (gitignored)
//   integration branch   cc/<missionId>/integration
//   lead worktree dir    worktrees/<missionId>/integration
//   owner branch         cc/<missionId>/work/<itemId>
//   owner worktree dir   worktrees/<missionId>/work-<itemId>
// ---------------------------------------------------------------------------

describe("worktree naming", () => {
	const repo = "/repo"

	test("worktreeRoot is <repo>/.command-center/worktrees/", () => {
		expect(worktreeRoot(repo)).toBe("/repo/.command-center/worktrees")
	})

	test("integrationBranch is cc/<missionId>/integration", () => {
		expect(integrationBranch("7k3a9fqa")).toBe("cc/7k3a9fqa/integration")
	})

	test("integrationWorktreeDir is worktrees/<missionId>/integration", () => {
		expect(integrationWorktreeDir(repo, "7k3a9fqa")).toBe(
			"/repo/.command-center/worktrees/7k3a9fqa/integration",
		)
	})

	test("ownerBranch is cc/<missionId>/work/<itemId>", () => {
		expect(ownerBranch("7k3a9fqa", 3)).toBe("cc/7k3a9fqa/work/3")
	})

	test("ownerWorktreeDir is worktrees/<missionId>/work-<itemId>", () => {
		expect(ownerWorktreeDir(repo, "7k3a9fqa", 3)).toBe(
			"/repo/.command-center/worktrees/7k3a9fqa/work-3",
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
