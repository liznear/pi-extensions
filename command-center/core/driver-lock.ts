import { rmSync } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { hostname } from "node:os"
import { dirname, join } from "node:path"
import { fileExists } from "./fs"
import { defaultStoreRoot } from "./store-file"

// ---------------------------------------------------------------------------
// Driver Lock (multi-process coordination).
//
// Driving a mission mutates shared state (the FileStore under the store root
// and the git worktrees under the repo). The single-writer invariant in
// store-file.ts holds only when ONE driver drives a mission at a time.
// The Driver Lock is the cross-process protocol that enforces that:
//
//   - A process acquires the mission's lock BEFORE it starts driving (any
//     drive entry point) and releases it when the drive parks / terminates.
//   - Driving is explicit: there is NO auto-resume. A Run drives only because
//     a host called a drive method (define / resume / review / abort / ...).
//   - Explicit commands take over: a mutating command force-acquires the
//     lock even when another live process currently drives (user intent
//     wins), and the displaced driver stops at its next loop iteration.
//   - Locks are advisory + reclaimable: the lock file records the holder's
//     pid + hostname; a holder whose pid is dead (crash) or whose hostname
//     differs (unverifiable) is stale and can be reclaimed without force.
//
// On-disk layout: <root>/missions/<missionId>/driver.lock  (root defaults to
// $HOME/.command-center, same as FileStore). Atomic create via `wx` write;
// atomic release via rm (holder-checked so we never delete a foreign lock).
// ---------------------------------------------------------------------------

/** The identity recorded in a driver lock file. */
export interface DriverLockInfo {
	/** pid of the driving process. */
	pid: number
	/** hostname the driving process runs on (pid reuse is host-scoped). */
	hostname: string
	/** epoch ms when the lock was acquired. */
	startedAt: number
	/** The mission this lock guards. */
	missionId: string
}

/** Outcome of an acquire attempt. */
export type LockAcquireResult =
	| { acquired: true; tookOverFrom?: DriverLockInfo }
	| { acquired: false; holder: DriverLockInfo }

/** Read-side view of a mission's lock. */
export interface DriverLockStatus {
	/** True iff a LIVE holder currently owns the lock (stale = not held). */
	held: boolean
	/** True iff the current process owns the lock. */
	byMe: boolean
	/** The recorded holder, when a lock file exists. */
	holder?: DriverLockInfo
}

/**
 * The cross-process coordination seam. The Orchestrator drives through this
 * interface; a consumer wires a FileDriverLock (real) or a NoopDriverLock
 * (tests). NoopDriverLock always "holds" so in-process-only behavior and
 * existing tests are unchanged.
 */
export interface DriverLock {
	/**
	 * Acquire the mission's lock. `force` (explicit takeover) overwrites a
	 * live foreign holder; without force a live foreign holder refuses.
	 * Reentrant: a process that already holds re-acquires trivially.
	 */
	acquire(
		missionId: string,
		opts?: { force?: boolean },
	): Promise<LockAcquireResult>
	/** Release the lock IF the current process holds it (never a foreign lock). */
	release(missionId: string): Promise<void>
	/** Read-only view of the mission's lock. */
	status(missionId: string): Promise<DriverLockStatus>
	/** True iff the current process currently holds a live lock on the mission. */
	isHeldByMe(missionId: string): Promise<boolean>
}

/** True iff `pid` is a live process on this machine (EPERM counts as alive). */
function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM"
	}
}

/**
 * A lock is live iff its holder is verifiably alive on this host — or on a
 * foreign host (liveness is unverifiable there, so we assume live; only
 * force can displace it).
 */
function holderAlive(info: DriverLockInfo): boolean {
	if (info.hostname !== hostname()) return true
	return pidAlive(info.pid)
}

/** Lock file paths acquired by THIS process (across all instances). */
const acquiredPaths = new Set<string>()

let exitHookInstalled = false
/** Best-effort cleanup of our locks on process exit (crashes leave stale files, which are reclaimable). */
function installExitHook(): void {
	if (exitHookInstalled) return
	exitHookInstalled = true
	process.once("exit", () => {
		for (const path of acquiredPaths) {
			try {
				rmSync(path, { force: true })
			} catch {
				// best effort — a stale lock is reclaimable later
			}
		}
	})
}

function lockPath(missionId: string, root: string): string {
	return join(root, "missions", missionId, "driver.lock")
}

export class FileDriverLock implements DriverLock {
	private readonly root: string

	/** @param root Store root; defaults to the same root as FileStore. */
	constructor(root: string = defaultStoreRoot()) {
		this.root = root
		installExitHook()
	}

	async acquire(
		missionId: string,
		opts: { force?: boolean } = {},
	): Promise<LockAcquireResult> {
		const path = lockPath(missionId, this.root)

		// Reentrant: we already hold it (same pid + host) — no-op.
		const current = await this.readLock(path)
		if (current && this.isMine(current)) {
			return { acquired: true }
		}

		const me: DriverLockInfo = {
			pid: process.pid,
			hostname: hostname(),
			startedAt: Date.now(),
			missionId,
		}

		// Ensure the mission dir exists (a drive/teardown can target a mission
		// whose state dir is absent, e.g. delete of a stubless mission).
		await mkdir(dirname(path), { recursive: true })

		// Atomic claim: fails with EEXIST if anyone holds the file.
		try {
			await writeFile(path, JSON.stringify(me, null, 2), { flag: "wx" })
			acquiredPaths.add(path)
			return { acquired: true }
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
		}

		// The file exists. Re-read for the holder (it may have been released
		// between the failed wx-write and now).
		const holder = await this.readLock(path)
		if (holder && holderAlive(holder) && !opts.force) {
			return { acquired: false, holder }
		}

		// Stale (dead pid / foreign host / released) or forced takeover.
		await writeFile(path, JSON.stringify(me, null, 2))
		acquiredPaths.add(path)
		return { acquired: true, tookOverFrom: holder ?? undefined }
	}

	async release(missionId: string): Promise<void> {
		const path = lockPath(missionId, this.root)
		const holder = await this.readLock(path)
		if (!holder) return
		const mine = this.isMine(holder)
		if (mine || !holderAlive(holder)) {
			// Ours, or a stale lock left by a dead driver — clean it up.
			await rm(path, { force: true }).catch(() => {})
			acquiredPaths.delete(path)
		}
		// A live foreign lock is NOT ours to remove.
	}

	async status(missionId: string): Promise<DriverLockStatus> {
		const holder = await this.readLock(lockPath(missionId, this.root))
		if (!holder) return { held: false, byMe: false }
		return {
			held: holderAlive(holder),
			byMe: this.isMine(holder),
			holder,
		}
	}

	async isHeldByMe(missionId: string): Promise<boolean> {
		const s = await this.status(missionId)
		return s.held && s.byMe
	}

	private isMine(info: DriverLockInfo): boolean {
		return info.pid === process.pid && info.hostname === hostname()
	}

	/** Read + parse the lock file; corrupt/absent → null (recoverable). */
	private async readLock(path: string): Promise<DriverLockInfo | null> {
		if (!(await fileExists(path))) return null
		try {
			const text = await readFile(path, "utf8")
			return JSON.parse(text) as DriverLockInfo
		} catch {
			return null
		}
	}
}

/** In-process default for tests / single-process consumers: always "holds". */
export class NoopDriverLock implements DriverLock {
	async acquire(): Promise<LockAcquireResult> {
		return { acquired: true }
	}

	async release(): Promise<void> {}

	async status(): Promise<DriverLockStatus> {
		return { held: false, byMe: false }
	}

	async isHeldByMe(): Promise<boolean> {
		return true
	}
}
