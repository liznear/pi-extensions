import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { $ } from "bun"
import {
	integrationBranch,
	integrationWorktreeDir,
	ownerBranch,
	ownerWorktreeDir,
	WorktreeProvisioner,
} from "../worktree/provisioner"

// ---------------------------------------------------------------------------
// Provisioner integration tests against a real temp git repo.
//
// These exercise the git ops (ticket 06 D4/D6): create integration worktree at
// mission start, create owner worktree lazily on dispatch, accept-merge --no-ff
// clean vs conflict (abort + name files), teardown on terminal, .command-center
// gitignored. Idempotency is covered (resume across runs).
// ---------------------------------------------------------------------------

let repo: string
let prov: WorktreeProvisioner
const repos: string[] = []

beforeEach(async () => {
	repo = await mkdtemp("cc-repo")
	repos.push(repo)
	await $`git init -q`.cwd(repo).quiet()
	await $`git config user.email t@t.t`.cwd(repo).quiet()
	await $`git config user.name t`.cwd(repo).quiet()
	await writeFile(`${repo}/README.md`, "hello\n")
	await $`git add -A`.cwd(repo).quiet()
	await $`git commit -qm init`.cwd(repo).quiet()
	prov = new WorktreeProvisioner()
})

afterEach(async () => {
	for (const r of repos.splice(0)) {
		await rm(r, { recursive: true, force: true })
	}
})

const MISSION = "7k3a9fqa"

async function mkdtemp(prefix: string): Promise<string> {
	const dir = join(tmpdir(), `${prefix}.${Math.random().toString(36).slice(2)}`)
	await $`mkdir -p ${dir}`.quiet()
	return dir
}

describe("WorktreeProvisioner — gitignore", () => {
	// The user may have a global core.excludesFile that already ignores
	// .command-center/, in which case ensureGitignored correctly no-ops (that's
	// the point of the git check-ignore guard). To test the repo-local append
	// path deterministically, neutralize the global excludesFile per repo.
	beforeEach(async () => {
		await $`git config core.excludesFile ""`.cwd(repo).quiet().nothrow()
	})

	test("ensureGitignored appends .command-center/ when absent", async () => {
		await prov.ensureGitignored(repo)
		const txt = await readFile(`${repo}/.gitignore`, "utf8")
		expect(txt).toContain(".command-center/")
	})

	test("ensureGitignored is idempotent (no duplicate lines)", async () => {
		await prov.ensureGitignored(repo)
		await prov.ensureGitignored(repo)
		const txt = await readFile(`${repo}/.gitignore`, "utf8")
		expect(txt.match(/\.command-center\//g)).toHaveLength(1)
	})

	test("ensureGitignored appends to an existing .gitignore without breaking it", async () => {
		await writeFile(`${repo}/.gitignore`, "node_modules\n")
		await prov.ensureGitignored(repo)
		const txt = await readFile(`${repo}/.gitignore`, "utf8")
		expect(txt).toContain("node_modules")
		expect(txt).toContain(".command-center/")
	})

	test("ensureGitignored is a no-op when already ignored (e.g. globally)", async () => {
		// Simulate a pre-existing ignore (repo-local) — ensureGitignored must not
		// append a duplicate or touch the file.
		await writeFile(`${repo}/.gitignore`, ".command-center/\n")
		await prov.ensureGitignored(repo)
		const txt = await readFile(`${repo}/.gitignore`, "utf8")
		expect(txt.match(/\.command-center\//g)).toHaveLength(1)
	})
})

describe("WorktreeProvisioner — integration worktree (lead)", () => {
	test("createIntegrationWorktree cuts the branch off HEAD and checks it out", async () => {
		const dir = await prov.createIntegrationWorktree(repo, MISSION)
		expect(dir).toBe(integrationWorktreeDir(repo, MISSION))
		// worktree checkout exists
		expect(await prov.worktreeExists(dir)).toBe(true)
		// branch exists
		expect(await prov.branchExists(repo, integrationBranch(MISSION))).toBe(true)
		// the checked-out worktree shares HEAD content
		expect(await readFile(`${dir}/README.md`, "utf8")).toBe("hello\n")
	})

	test("createIntegrationWorktree is idempotent (resume across runs)", async () => {
		const dir1 = await prov.createIntegrationWorktree(repo, MISSION)
		// second call must not throw and returns the same dir
		const dir2 = await prov.createIntegrationWorktree(repo, MISSION)
		expect(dir2).toBe(dir1)
		expect(await prov.worktreeExists(dir1)).toBe(true)
	})

	test("integrationDir returns the computed path", () => {
		expect(prov.integrationDir(repo, MISSION)).toBe(
			integrationWorktreeDir(repo, MISSION),
		)
	})

	test("removeIntegrationWorktree removes the checkout but keeps the branch", async () => {
		await prov.createIntegrationWorktree(repo, MISSION)
		expect(await prov.branchExists(repo, integrationBranch(MISSION))).toBe(true)
		await prov.removeIntegrationWorktree(repo, MISSION)
		// checkout gone, branch persists (the deliverable)
		expect(
			await prov.worktreeExists(integrationWorktreeDir(repo, MISSION)),
		).toBe(false)
		expect(await prov.branchExists(repo, integrationBranch(MISSION))).toBe(true)
	})

	test("removeIntegrationWorktree is a no-op when absent", async () => {
		await expect(
			prov.removeIntegrationWorktree(repo, MISSION),
		).resolves.toBeUndefined()
	})
})

describe("WorktreeProvisioner — owner worktree", () => {
	test("createOwnerWorktree cuts off the current integration tip", async () => {
		await prov.createIntegrationWorktree(repo, MISSION)
		const dir = await prov.createOwnerWorktree(repo, MISSION, 1)
		expect(dir).toBe(ownerWorktreeDir(repo, MISSION, 1))
		expect(await prov.worktreeExists(dir)).toBe(true)
		expect(await prov.branchExists(repo, ownerBranch(MISSION, 1))).toBe(true)
	})

	test("createOwnerWorktree is idempotent (resume across rework)", async () => {
		await prov.createIntegrationWorktree(repo, MISSION)
		const d1 = await prov.createOwnerWorktree(repo, MISSION, 1)
		const d2 = await prov.createOwnerWorktree(repo, MISSION, 1)
		expect(d2).toBe(d1)
		expect(await prov.worktreeExists(d1)).toBe(true)
	})

	test("removeOwnerWorktree removes the checkout AND the branch", async () => {
		await prov.createIntegrationWorktree(repo, MISSION)
		await prov.createOwnerWorktree(repo, MISSION, 1)
		expect(await prov.branchExists(repo, ownerBranch(MISSION, 1))).toBe(true)
		await prov.removeOwnerWorktree(repo, MISSION, 1)
		expect(await prov.worktreeExists(ownerWorktreeDir(repo, MISSION, 1))).toBe(
			false,
		)
		expect(await prov.branchExists(repo, ownerBranch(MISSION, 1))).toBe(false)
	})

	test("removeOwnerWorktree is a no-op when absent", async () => {
		await expect(
			prov.removeOwnerWorktree(repo, MISSION, 1),
		).resolves.toBeUndefined()
	})
})

describe("WorktreeProvisioner — accept merge (ticket 06 D6)", () => {
	test("clean merge → ok:true and lands an auditable merge commit", async () => {
		await prov.createIntegrationWorktree(repo, MISSION)
		// owner commits a NEW file (no conflict)
		const ownerDir = await prov.createOwnerWorktree(repo, MISSION, 1)
		await writeFile(`${ownerDir}/feature.ts`, "export const x = 1\n")
		await $`git add -A && git commit -qm feat`.cwd(ownerDir).quiet()

		const res = await prov.acceptMerge(repo, MISSION, 1, "Add feature")
		expect(res).toEqual({ ok: true })

		// the merge landed in integration
		const integDir = integrationWorktreeDir(repo, MISSION)
		const log = (
			await $`git log --oneline -1`.cwd(integDir).quiet().text()
		).trim()
		expect(log).toContain("Accept #1 Add feature")
		expect(await readFile(`${integDir}/feature.ts`, "utf8")).toContain(
			"export const x = 1",
		)
	})

	test("conflicting merge → ok:false, names conflicting files, integration left clean", async () => {
		await prov.createIntegrationWorktree(repo, MISSION)
		// owner edits the same line as a subsequent integration change
		const ownerDir = await prov.createOwnerWorktree(repo, MISSION, 2)
		await writeFile(`${ownerDir}/README.md`, "owner-version\n")
		await $`git add -A && git commit -qm owner-edit`.cwd(ownerDir).quiet()

		// advance integration so the merge conflicts
		const integDir = integrationWorktreeDir(repo, MISSION)
		await writeFile(`${integDir}/README.md`, "integration-version\n")
		await $`git add -A && git commit -qm integ-edit`.cwd(integDir).quiet()

		const res = await prov.acceptMerge(repo, MISSION, 2, "Conflicting change")
		expect(res.ok).toBe(false)
		if (!res.ok) {
			expect(res.conflictingFiles).toContain("README.md")
		}

		// integration left clean (merge aborted), content unchanged
		expect(await readFile(`${integDir}/README.md`, "utf8")).toBe(
			"integration-version\n",
		)
		// no merge in progress
		const status = await $`git status --porcelain`.cwd(integDir).quiet().text()
		expect(status).not.toContain("UU ")
	})

	test("owner branch is intact after a conflicting accept (can rework)", async () => {
		await prov.createIntegrationWorktree(repo, MISSION)
		const ownerDir = await prov.createOwnerWorktree(repo, MISSION, 3)
		await writeFile(`${ownerDir}/README.md`, "owner-version\n")
		await $`git add -A && git commit -qm owner-edit`.cwd(ownerDir).quiet()
		const integDir = integrationWorktreeDir(repo, MISSION)
		await writeFile(`${integDir}/README.md`, "integration-version\n")
		await $`git add -A && git commit -qm integ-edit`.cwd(integDir).quiet()

		await prov.acceptMerge(repo, MISSION, 3, "Conflicting change")

		// owner branch + worktree still present for the resumed rework session
		expect(await prov.branchExists(repo, ownerBranch(MISSION, 3))).toBe(true)
		expect(await prov.worktreeExists(ownerDir)).toBe(true)
		// owner content untouched
		expect(await readFile(`${ownerDir}/README.md`, "utf8")).toBe(
			"owner-version\n",
		)
	})
})
