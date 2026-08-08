import { afterEach, describe, expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { hostname, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { $ } from "bun"
import { type DriverLockInfo, FileDriverLock } from "../driver-lock"

// ---------------------------------------------------------------------------
// FileDriverLock — the cross-process driver-lock protocol.
//
// A foreign process is simulated by planting a lock file with a fabricated
// holder identity (a real process can't be spawned cheaply in-unit):
//   - pid 1 (launchd/init) is a LIVE foreign holder;
//   - a pid taken from a spawned-and-exited child is a DEAD (stale) holder.
// Both run under the same hostname, matching the host the tests run on.
// ---------------------------------------------------------------------------

let root: string
const roots: string[] = []

afterEach(async () => {
	for (const r of roots.splice(0)) {
		await rm(r, { recursive: true, force: true })
	}
})

async function freshRoot(): Promise<string> {
	const dir = join(tmpdir(), `cc-lock.${Math.random().toString(36).slice(2)}`)
	await $`mkdir -p ${dir}`.quiet()
	roots.push(dir)
	return dir
}

const MISSION = "abc12345"

function lockFilePath(rootDir: string, missionId: string): string {
	return join(rootDir, "missions", missionId, "driver.lock")
}

/** Plant a lock file as if a foreign process wrote it. */
async function plantLock(
	rootDir: string,
	missionId: string,
	pid: number,
): Promise<void> {
	const path = lockFilePath(rootDir, missionId)
	await mkdir(dirname(path), { recursive: true })
	const info: DriverLockInfo = {
		pid,
		hostname: hostname(),
		startedAt: Date.now(),
		missionId,
	}
	await writeFile(path, JSON.stringify(info, null, 2))
}

/** A pid guaranteed to be dead: spawn `true`, take its pid after it exits. */
function deadPid(): Promise<number> {
	return new Promise((resolve) => {
		const child = execFile("true")
		child.on("exit", () => resolve(child.pid ?? 0))
	})
}

describe("FileDriverLock", () => {
	test("acquire → status → release roundtrip", async () => {
		root = await freshRoot()
		const lock = new FileDriverLock(root)

		const result = await lock.acquire(MISSION)
		expect(result.acquired).toBe(true)

		const status = await lock.status(MISSION)
		expect(status.held).toBe(true)
		expect(status.byMe).toBe(true)
		expect(status.holder?.pid).toBe(process.pid)

		expect(await lock.isHeldByMe(MISSION)).toBe(true)

		await lock.release(MISSION)
		const after = await lock.status(MISSION)
		expect(after.held).toBe(false)
		expect(after.byMe).toBe(false)
		expect(await lock.isHeldByMe(MISSION)).toBe(false)

		// Release is idempotent on an absent lock.
		await expect(lock.release(MISSION)).resolves.toBeUndefined()
	})

	test("acquire is reentrant for the current process", async () => {
		root = await freshRoot()
		const lock = new FileDriverLock(root)

		expect((await lock.acquire(MISSION)).acquired).toBe(true)
		const again = await lock.acquire(MISSION)
		expect(again.acquired).toBe(true)
		if (again.acquired) {
			expect(again.tookOverFrom).toBeUndefined()
		}

		// Still a single lock file owned by us.
		const status = await lock.status(MISSION)
		expect(status.byMe).toBe(true)
	})

	test("non-force acquire refuses a live foreign holder", async () => {
		root = await freshRoot()
		await plantLock(root, MISSION, 1) // pid 1 = live (launchd/init)
		const lock = new FileDriverLock(root)

		const result = await lock.acquire(MISSION)
		expect(result.acquired).toBe(false)
		if (!result.acquired) {
			expect(result.holder.pid).toBe(1)
		}
		expect(await lock.isHeldByMe(MISSION)).toBe(false)
	})

	test("force acquire takes over from a live foreign holder", async () => {
		root = await freshRoot()
		await plantLock(root, MISSION, 1)
		const lock = new FileDriverLock(root)

		const result = await lock.acquire(MISSION, { force: true })
		expect(result.acquired).toBe(true)
		if (result.acquired) {
			expect(result.tookOverFrom?.pid).toBe(1)
		}

		const status = await lock.status(MISSION)
		expect(status.byMe).toBe(true)
	})

	test("a stale lock (dead pid) is reclaimable without force", async () => {
		root = await freshRoot()
		const dead = await deadPid()
		await plantLock(root, MISSION, dead)
		const lock = new FileDriverLock(root)

		const result = await lock.acquire(MISSION)
		expect(result.acquired).toBe(true)
		if (result.acquired) {
			// The dead holder is reported as displaced, not as a refusal.
			expect(result.tookOverFrom?.pid).toBe(dead)
		}
		expect(await lock.isHeldByMe(MISSION)).toBe(true)
	})

	test("release does not remove a live foreign lock", async () => {
		root = await freshRoot()
		await plantLock(root, MISSION, 1)
		const lock = new FileDriverLock(root)

		await lock.release(MISSION)

		const status = await lock.status(MISSION)
		expect(status.held).toBe(true)
		expect(status.byMe).toBe(false)
		expect(status.holder?.pid).toBe(1)
	})

	test("release removes a stale lock left by a dead driver", async () => {
		root = await freshRoot()
		const dead = await deadPid()
		await plantLock(root, MISSION, dead)
		const lock = new FileDriverLock(root)

		await lock.release(MISSION)

		expect((await lock.status(MISSION)).held).toBe(false)
	})

	test("isHeldByMe flips false once a foreign process steals the lock", async () => {
		root = await freshRoot()
		const lock = new FileDriverLock(root)

		await lock.acquire(MISSION)
		expect(await lock.isHeldByMe(MISSION)).toBe(true)

		// Another process force-takes over (overwrites our file).
		await plantLock(root, MISSION, 1)

		expect(await lock.isHeldByMe(MISSION)).toBe(false)
		expect((await lock.status(MISSION)).byMe).toBe(false)
	})

	test("status reports the foreign holder's details", async () => {
		root = await freshRoot()
		await plantLock(root, MISSION, 1)
		const lock = new FileDriverLock(root)

		const status = await lock.status(MISSION)
		expect(status.held).toBe(true)
		expect(status.byMe).toBe(false)
		expect(status.holder).toMatchObject({
			pid: 1,
			hostname: hostname(),
			missionId: MISSION,
		})
	})

	test("a corrupt lock file is treated as absent (recoverable)", async () => {
		root = await freshRoot()
		const path = lockFilePath(root, MISSION)
		await mkdir(dirname(path), { recursive: true })
		await writeFile(path, "not json{{{")

		const lock = new FileDriverLock(root)
		const result = await lock.acquire(MISSION)
		expect(result.acquired).toBe(true)
		expect(await lock.isHeldByMe(MISSION)).toBe(true)
	})

	test("lock files are scoped per mission", async () => {
		root = await freshRoot()
		const lock = new FileDriverLock(root)

		await lock.acquire(MISSION)
		expect((await lock.status("zzz99999")).held).toBe(false)
		expect((await lock.status(MISSION)).held).toBe(true)
	})
})
