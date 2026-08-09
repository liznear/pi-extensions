import { execFile } from "node:child_process"
import { readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { fileExists } from "../fs"

// ---------------------------------------------------------------------------
// Worktree naming (ticket 06 D3) — a pure function of identity (missionId,
// itemId). No random/stateful components; owner names key off the stable id.
//
//   worktree root        $HOME/.command-center/worktrees/
//   integration branch   cc/<missionId>/integration
//   lead worktree dir    worktrees/<missionId>/integration
//   owner branch         cc/<missionId>/work/<itemId>
//   owner worktree dir   worktrees/<missionId>/work-<itemId>
//
// Worktree checkouts live outside the source repo; repoPath still identifies
// the source repo used for branch and git operations.
// ---------------------------------------------------------------------------

const execFileP = promisify(execFile)

const WORKTREE_DIR = "worktrees"

/** The global managed worktree root: `$HOME/.command-center/worktrees/`. */
export function worktreeRoot(_repoPath: string): string {
	return join(homedir(), ".command-center", WORKTREE_DIR)
}

/** Integration branch: `cc/<missionId>/integration`. */
export function integrationBranch(missionId: string): string {
	return `cc/${missionId}/integration`
}

/** Lead worktree directory: `worktrees/<missionId>/integration`. */
export function integrationWorktreeDir(
	repoPath: string,
	missionId: string,
): string {
	return join(worktreeRoot(repoPath), missionId, "integration")
}

/** Owner branch: `cc/<missionId>/work/<itemId>`. */
export function ownerBranch(missionId: string, itemId: number): string {
	return `cc/${missionId}/work/${itemId}`
}

/** Owner worktree directory: `worktrees/<missionId>/work-<itemId>`. */
export function ownerWorktreeDir(
	repoPath: string,
	missionId: string,
	itemId: number,
): string {
	return join(worktreeRoot(repoPath), missionId, `work-${itemId}`)
}

// ---------------------------------------------------------------------------
// WorktreeProvisioner (ticket 06 D1/D4/D5/D6).
//
// Orchestrator-managed git worktrees. Uniform provisioning: the lead's
// Integration Worktree and every owner worktree take the same code path; the
// lead is simply "the worktree on the integration branch."
//
// Lifecycle:
//   - Lead integration worktree: created at mission start, persists for the
//     whole mission, torn down on mission terminal (branch stays as the
//     deliverable; only the checkout is removed).
//   - Owner worktree: created lazily on dispatch (pending→in_progress), just
//     before starting/resuming the owner session; persists across rework;
//     torn down on terminal (accepted after merge / cancelled).
//
// Merge-on-accept (ticket 04 D5 / 06 D6): the Orchestrator runs
// `git merge --no-ff` in the Integration Worktree; on conflict, aborts, fails
// the tool result naming the conflicting files, leaves the item at
// ready_for_review.
// ---------------------------------------------------------------------------

/** Result of an accept-merge (ticket 06 D6). */
export type MergeResult =
	| { ok: true }
	| { ok: false; conflictingFiles: string[] }

/** Readiness of an owner branch before it can enter Mission Lead review. */
export type ReviewReadiness = { ready: true } | { ready: false; reason: string }

/**
 * The worktree operations the Orchestrator depends on (ticket 06).
 *
 * Model C (one Orchestrator, many missions across many repos): every method
 * takes the mission's `repoPath` as its first argument — a single stateless
 * provider serves all repos. WorktreeProvisioner (git-backed) is the default
 * impl; tests substitute a FakeWorktreeProvider (no git).
 */
export interface WorktreeProvider {
	ensureGitignored(repoPath: string): Promise<void>
	createIntegrationWorktree(
		repoPath: string,
		missionId: string,
	): Promise<string>
	removeIntegrationWorktree(repoPath: string, missionId: string): Promise<void>
	/** Delete the integration branch (`cc/<missionId>/integration`). */
	removeIntegrationBranch(repoPath: string, missionId: string): Promise<void>
	createOwnerWorktree(
		repoPath: string,
		missionId: string,
		itemId: number,
	): Promise<string>
	removeOwnerWorktree(
		repoPath: string,
		missionId: string,
		itemId: number,
	): Promise<void>
	reviewReadiness(
		repoPath: string,
		missionId: string,
		itemId: number,
		noChangesExpected: boolean,
	): Promise<ReviewReadiness>
	acceptMerge(
		repoPath: string,
		missionId: string,
		itemId: number,
		title: string,
	): Promise<MergeResult>
	integrationDir(repoPath: string, missionId: string): string
	ownerDir(repoPath: string, missionId: string, itemId: number): string
}

export class WorktreeProvisioner implements WorktreeProvider {
	// Stateless (Model C): repoPath is supplied per call, so a single provider
	// instance serves worktrees across many repos.

	// --- repo-wide setup -----------------------------------------------------

	/**
	 * Ensure `.command-center/` is gitignored (idempotent). Asks git whether
	 * the path is ALREADY ignored (via `git check-ignore`, which consults every
	 * ignore source — the repo's .gitignore, .git/info/exclude, parent dirs, and
	 * the global core.excludesFile); if so, this is a no-op. Otherwise it appends
	 * `.command-center/` to the repo's .gitignore.
	 */
	async ensureGitignored(repoPath: string): Promise<void> {
		const dir = `${repoPath}/.command-center`
		// `git check-ignore -q <path>` exits 0 if ignored, 1 if not.
		const check = await this.git(["check-ignore", "-q", dir], repoPath)
		if (check.code === 0) return // already ignored by some source

		const gitignore = `${repoPath}/.gitignore`
		const desiredLine = ".command-center/"
		const exists = await fileExists(gitignore)
		const current = exists ? await readFile(gitignore, "utf8") : ""
		if (current.split("\n").includes(desiredLine)) return
		const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : ""
		const suffix = current.endsWith("\n") ? "" : "\n"
		await writeFile(
			gitignore,
			`${current}${prefix}${desiredLine}${suffix}`,
			"utf8",
		)
	}

	/** Run a git command in `cwd`. Does NOT throw on non-zero exit (use for
	 *  predicate commands like `check-ignore`, `branch --list`, `merge`). */
	private async git(
		args: string[],
		cwd: string,
	): Promise<{ stdout: string; stderr: string; code: number }> {
		try {
			const { stdout, stderr } = await execFileP("git", args, {
				cwd,
				maxBuffer: 10 * 1024 * 1024,
			})
			return { stdout, stderr, code: 0 }
		} catch (err) {
			// execFile rejects on non-zero exit; the rejection carries the captured
			// stdout/stderr and the exit `code` (null on signal kill → fall back to 1).
			const e = err as NodeJS.ErrnoException & {
				stdout?: string
				stderr?: string
				code?: number
			}
			return {
				stdout: e.stdout ?? "",
				stderr: e.stderr ?? "",
				code: e.code ?? 1,
			}
		}
	}

	/**
	 * Run a git command in `cwd` and THROW on non-zero exit. Use for mutating
	 * commands (`branch`, `worktree add`, `merge`, …) whose failure must not be
	 * silently swallowed — otherwise the provider would report success without
	 * having created anything (e.g. an empty repo with no HEAD).
	 */
	private async gitOrThrow(args: string[], cwd: string): Promise<string> {
		const r = await this.git(args, cwd)
		if (r.code !== 0) {
			throw new Error(
				`git ${args.join(" ")} failed (exit ${r.code}) in ${cwd}\n${r.stderr}`,
			)
		}
		return r.stdout
	}

	/** Does a branch exist in `repoPath`? */
	async branchExists(repoPath: string, branch: string): Promise<boolean> {
		const r = await this.git(["branch", "--list", branch], repoPath)
		// `git branch --list <name>` prints the name (with a `*` if current) or nothing.
		return r.stdout.trim().length > 0
	}

	/** Does a worktree checkout exist at `dir`? */
	async worktreeExists(dir: string): Promise<boolean> {
		return fileExists(`${dir}/.git`)
	}

	// --- lead integration worktree ------------------------------------------

	/**
	 * Create the lead's Integration Worktree at mission start (ticket 06 D4).
	 * Cuts `cc/<missionId>/integration` off the repo's current HEAD and checks
	 * it out into `$HOME/.command-center/worktrees/<missionId>/integration`.
	 * Idempotent: if the
	 * branch/worktree already exist (e.g. resuming across runs), this is a no-op.
	 */
	async createIntegrationWorktree(
		repoPath: string,
		missionId: string,
	): Promise<string> {
		const branch = integrationBranch(missionId)
		const dir = integrationWorktreeDir(repoPath, missionId)
		if (await this.worktreeExists(dir)) return dir

		if (!(await this.branchExists(repoPath, branch))) {
			// Cut the integration branch off the current HEAD.
			await this.gitOrThrow(["branch", branch, "HEAD"], repoPath)
		}
		// Check the branch out directly (not --detach) so the Orchestrator's
		// accept-merge and any lead inspection commits land ON the branch.
		await this.gitOrThrow(["worktree", "add", dir, branch], repoPath)
		return dir
	}

	/**
	 * Tear down the Integration Worktree's checkout on mission terminal
	 * (ticket 06 D4). The integration branch persists as the deliverable; only
	 * the worktree checkout is removed.
	 */
	async removeIntegrationWorktree(
		repoPath: string,
		missionId: string,
	): Promise<void> {
		const dir = integrationWorktreeDir(repoPath, missionId)
		if (await this.worktreeExists(dir)) {
			await this.gitOrThrow(["worktree", "remove", "--force", dir], repoPath)
		}
	}

	/** Delete the integration branch (best-effort; no-op if absent). */
	async removeIntegrationBranch(
		repoPath: string,
		missionId: string,
	): Promise<void> {
		const branch = integrationBranch(missionId)
		if (await this.branchExists(repoPath, branch)) {
			await this.gitOrThrow(["branch", "-D", branch], repoPath)
		}
	}

	/** The integration worktree dir (computed; the lead's cwd). */
	integrationDir(repoPath: string, missionId: string): string {
		return integrationWorktreeDir(repoPath, missionId)
	}

	// --- owner worktree -----------------------------------------------------

	/**
	 * Create an owner worktree lazily on dispatch (ticket 06 D4). Cuts
	 * `cc/<missionId>/work/<itemId>` off the CURRENT integration tip and checks
	 * it out into `$HOME/.command-center/worktrees/<missionId>/work-<itemId>`.
	 * Idempotent.
	 */
	async createOwnerWorktree(
		repoPath: string,
		missionId: string,
		itemId: number,
	): Promise<string> {
		const branch = ownerBranch(missionId, itemId)
		const dir = ownerWorktreeDir(repoPath, missionId, itemId)
		if (await this.worktreeExists(dir)) return dir

		const integBranch = integrationBranch(missionId)
		if (!(await this.branchExists(repoPath, branch))) {
			// Cut off the current integration tip so fresh dispatches start current.
			await this.gitOrThrow(["branch", branch, integBranch], repoPath)
		}
		// Check the branch out directly (not --detach) so the owner's commits
		// land ON its branch (the merge target).
		await this.gitOrThrow(["worktree", "add", dir, branch], repoPath)
		return dir
	}

	/**
	 * Tear down an owner worktree on terminal (ticket 06 D4): accepted (after
	 * the merge lands) or cancelled (abandon). The owner branch is deleted too
	 * (its content is in integration, or abandoned).
	 */
	async removeOwnerWorktree(
		repoPath: string,
		missionId: string,
		itemId: number,
	): Promise<void> {
		const dir = ownerWorktreeDir(repoPath, missionId, itemId)
		if (await this.worktreeExists(dir)) {
			await this.gitOrThrow(["worktree", "remove", "--force", dir], repoPath)
		}
		const branch = ownerBranch(missionId, itemId)
		if (await this.branchExists(repoPath, branch)) {
			await this.gitOrThrow(["branch", "-D", branch], repoPath)
		}
	}

	/**
	 * Validate the branch/worktree handoff before notifying the Mission Lead.
	 * This is intentionally separate from acceptMerge: accepting a review must
	 * never be the first point at which we discover that the owner only changed
	 * an uncommitted worktree or started from stale integration.
	 */
	async reviewReadiness(
		repoPath: string,
		missionId: string,
		itemId: number,
		noChangesExpected: boolean,
	): Promise<ReviewReadiness> {
		const branch = ownerBranch(missionId, itemId)
		const integration = integrationBranch(missionId)
		const ownerDir = ownerWorktreeDir(repoPath, missionId, itemId)

		if (!(await this.branchExists(repoPath, branch))) {
			return {
				ready: false,
				reason: `Owner branch ${branch} does not exist. Recreate the worktree before requesting review.`,
			}
		}

		const status = await this.git(
			["status", "--porcelain", "--untracked-files=all"],
			ownerDir,
		)
		if (status.code !== 0) {
			return {
				ready: false,
				reason: `Could not inspect the owner worktree: ${status.stderr.trim() || "git status failed"}.`,
			}
		}
		if (status.stdout.trim().length > 0) {
			return {
				ready: false,
				reason:
					"The owner worktree is dirty or contains untracked files. Commit all intended changes and leave `git status --porcelain` empty before requesting review.",
			}
		}

		const basedOnIntegration = await this.git(
			["merge-base", "--is-ancestor", integration, branch],
			repoPath,
		)
		if (basedOnIntegration.code !== 0) {
			return {
				ready: false,
				reason: `The owner branch is stale relative to ${integration}. Sync/rebase ${integration} into ${branch}, preserve accepted work, resolve conflicts, and verify again.`,
			}
		}

		const diff = await this.git(
			["diff", "--quiet", `${integration}..${branch}`],
			repoPath,
		)
		if (diff.code > 1) {
			return {
				ready: false,
				reason: `Could not inspect the committed owner diff: ${diff.stderr.trim() || "git diff failed"}.`,
			}
		}
		if (diff.code === 0 && !noChangesExpected) {
			return {
				ready: false,
				reason: `The owner branch has no committed diff against ${integration}. Commit the intended changes before requesting review, or explicitly mark this item as no-code in request_review.`,
			}
		}

		return { ready: true }
	}

	/** The owner worktree dir (computed; the owner's cwd). */
	ownerDir(repoPath: string, missionId: string, itemId: number): string {
		return ownerWorktreeDir(repoPath, missionId, itemId)
	}

	// --- accept merge (ticket 06 D6) ----------------------------------------

	/**
	 * Merge the owner's branch into the Integration Worktree (ticket 06 D6).
	 *
	 * - Clean → ok:true.
	 * - Conflict → abort (`git merge --abort`), integration left clean, the
	 *   conflicting files are returned; the caller fails the tool result with
	 *   them and leaves the item at ready_for_review.
	 *
	 * Always `--no-ff`: every accept is an explicit, auditable merge node with
	 * message `Accept #<itemId> <title>`.
	 */
	async acceptMerge(
		repoPath: string,
		missionId: string,
		itemId: number,
		title: string,
	): Promise<MergeResult> {
		const integDir = integrationWorktreeDir(repoPath, missionId)
		const owner = ownerBranch(missionId, itemId)
		const message = `Accept #${itemId} ${title}`
		const r = await this.git(
			["merge", "--no-ff", "-m", message, owner],
			integDir,
		)
		// git returns exit 0 even on conflict; detect via unmerged paths.
		const conflicts = await this.git(
			["diff", "--name-only", "--diff-filter=U"],
			integDir,
		)
		const conflictingFiles = conflicts.stdout
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l.length > 0)
		if (conflictingFiles.length > 0) {
			await this.git(["merge", "--abort"], integDir)
			return { ok: false, conflictingFiles }
		}
		void r
		return { ok: true }
	}
}

// ---------------------------------------------------------------------------
// FakeWorktreeProvider — for Orchestrator tests (no git; in-memory dirs).
// ---------------------------------------------------------------------------

export class FakeWorktreeProvider implements WorktreeProvider {
	private integrationDirs = new Set<string>()
	private ownerDirs = new Set<string>()
	/** Set of `${missionId}:${itemId}` that should conflict on acceptMerge. */
	conflictOn = new Set<string>()
	/** Readiness returned by the fake before lead review. */
	reviewReadinessResult: ReviewReadiness = { ready: true }
	/** Optional sequence for testing an automatic handoff retry. */
	reviewReadinessResults: ReviewReadiness[] = []
	/** Recorded calls, for assertions. */
	calls: string[] = []

	async ensureGitignored(_repoPath: string): Promise<void> {
		this.calls.push("ensureGitignored")
	}

	async createIntegrationWorktree(
		_repoPath: string,
		missionId: string,
	): Promise<string> {
		this.calls.push(`createIntegration:${missionId}`)
		const dir = integrationWorktreeDir("/fake-repo", missionId)
		this.integrationDirs.add(dir)
		return dir
	}

	async removeIntegrationWorktree(
		_repoPath: string,
		missionId: string,
	): Promise<void> {
		this.calls.push(`removeIntegration:${missionId}`)
		this.integrationDirs.delete(integrationWorktreeDir("/fake-repo", missionId))
	}

	async removeIntegrationBranch(
		_repoPath: string,
		missionId: string,
	): Promise<void> {
		this.calls.push(`removeIntegrationBranch:${missionId}`)
	}

	async createOwnerWorktree(
		_repoPath: string,
		missionId: string,
		itemId: number,
	): Promise<string> {
		this.calls.push(`createOwner:${missionId}:${itemId}`)
		const dir = ownerWorktreeDir("/fake-repo", missionId, itemId)
		this.ownerDirs.add(dir)
		return dir
	}

	async removeOwnerWorktree(
		_repoPath: string,
		missionId: string,
		itemId: number,
	): Promise<void> {
		this.calls.push(`removeOwner:${missionId}:${itemId}`)
		this.ownerDirs.delete(ownerWorktreeDir("/fake-repo", missionId, itemId))
	}

	async reviewReadiness(
		_repoPath: string,
		missionId: string,
		itemId: number,
		_noChangesExpected: boolean,
	): Promise<ReviewReadiness> {
		this.calls.push(`reviewReadiness:${missionId}:${itemId}`)
		return this.reviewReadinessResults.shift() ?? this.reviewReadinessResult
	}

	async acceptMerge(
		_repoPath: string,
		missionId: string,
		itemId: number,
		_title: string,
	): Promise<MergeResult> {
		this.calls.push(`acceptMerge:${missionId}:${itemId}`)
		if (this.conflictOn.has(`${missionId}:${itemId}`)) {
			return { ok: false, conflictingFiles: ["fake-conflict.ts"] }
		}
		return { ok: true }
	}

	integrationDir(_repoPath: string, missionId: string): string {
		return integrationWorktreeDir("/fake-repo", missionId)
	}

	ownerDir(_repoPath: string, missionId: string, itemId: number): string {
		return ownerWorktreeDir("/fake-repo", missionId, itemId)
	}
}
