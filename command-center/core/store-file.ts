import {
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileExists } from "./fs"
import type { Store } from "./store"
import type {
	HumanInputRequest,
	Mission,
	MissionStatus,
	MissionSummary,
	Plan,
	RoleIdentity,
	StatusReport,
	WorkItemStatus,
} from "./types"
import { summarizeWorkItems } from "./types"

// ---------------------------------------------------------------------------
// FileStore (persistence map / ticket 01).
//
// A JSON-on-disk implementation of the Store seam (core/store.ts): persists
// Mission / Plan / Memory under a global root so a mission's state survives
// process restarts. The Store interface is unchanged — this fills the seam
// with a concrete durable impl. The Orchestrator default stays InMemoryStore
// (tests stay fast + disk-free); the CLI wires FileStore so the proof runs
// against real persistence.
//
// On-disk layout (decided in charting — see map):
//
//   <root>/missions/<missionId>/mission.json          # full Mission (status, repoPath, ...)
//   <root>/missions/<missionId>/plan.json             # { items: WorkItem[] }
//   <root>/missions/<missionId>/memories/lead.md                 # mission lead
//   <root>/missions/<missionId>/memories/work-<itemId>.md        # each work item owner
//
// `root` defaults to $HOME/.command-center. Dirs are created lazily on first
// write (mkdir { recursive: true }). missionId is a globally-unique 8-char
// base36 slug (identity.ts) — no repo encoding in the path.
//
// Atomicity & concurrency — atomic write per file, single-writer invariant:
//
//   - Each write goes to a `<file>.tmp` sibling (same directory ⇒ same
//     filesystem) then `rename`s onto the final path (atomic on POSIX/Win).
//     A reader never observes a half-written file.
//   - There is NO file locking. Safety rests on a single-writer-per-file
//     invariant maintained by the Orchestrator:
//       · mission.json / plan.json — only the Orchestrator's single-threaded
//         reactor writes these (the accept gate is sequential — ticket 05 D3).
//       · memories/<role>.md — exactly one role writes each (lead ⇒ lead.md;
//         each owner ⇒ its own work-<itemId>.md). Concurrent owners hit
//         different files.
//   - Status writes (writeMissionStatus / writeWorkItemStatus) are
//     read-modify-write on the respective file, also single-writer (reactor).
//   - Cross-process coordination is provided by the Driver Lock
//     (core/driver-lock.ts): a Run holds the mission's lock while it drives,
//     and explicit commands take the lock over — so at most one driver
//     writes any given mission's files at a time.
//
// No-op-on-absent mirrors InMemoryStore semantics: a status write targeting a
// missing mission / plan / item returns without writing or throwing.
// ---------------------------------------------------------------------------

/** Default global root for library state: `$HOME/.command-center`. */
export function defaultStoreRoot(): string {
	return join(homedir(), ".command-center")
}

/**
 * Filename for a role's memory doc, relative to the mission's `memories/` dir.
 * Sibling to the Map-key `memoryKey` in store.ts (which is a `:`-joined key,
 * not a filename). lead ⇒ `lead.md`; a work item owner ⇒ `work-<itemId>.md`.
 */
export function memoryFileName(who: RoleIdentity): string {
	if (who.workItemId === undefined) return "lead.md"
	return `work-${who.workItemId}.md`
}

export class FileStore implements Store {
	private readonly root: string

	/**
	 * @param root Library root; defaults to `$HOME/.command-center`
	 *             (`defaultStoreRoot()`).
	 */
	constructor(root: string = defaultStoreRoot()) {
		this.root = root
	}

	// --- Mission ----------------------------------------------------------

	async writeMission(mission: Mission): Promise<void> {
		await this.writeJson(this.missionPath(mission.id), mission)
	}

	async readMission(missionId: string): Promise<Mission | null> {
		return this.readJson<Mission>(this.missionPath(missionId))
	}

	async writeMissionStatus(
		missionId: string,
		status: MissionStatus,
	): Promise<void> {
		const mission = await this.readMission(missionId)
		if (!mission) return
		await this.writeJson(this.missionPath(missionId), { ...mission, status })
	}

	/** Remove the mission's entire persisted directory (recursive, idempotent). */
	async deleteMission(missionId: string): Promise<void> {
		await rm(this.missionDir(missionId), {
			recursive: true,
			force: true,
		})
	}

	// --- Plan -------------------------------------------------------------

	async writePlan(missionId: string, plan: Plan): Promise<void> {
		await this.writeJson(this.planPath(missionId), plan)
	}

	async readPlan(missionId: string): Promise<Plan | null> {
		return this.readJson<Plan>(this.planPath(missionId))
	}

	async writeWorkItemStatus(
		missionId: string,
		workItemId: number,
		status: WorkItemStatus,
	): Promise<void> {
		const plan = await this.readPlan(missionId)
		if (!plan) return
		let changed = false
		const items = plan.items.map((it) => {
			if (it.id === workItemId) {
				changed = true
				return { ...it, status }
			}
			return it
		})
		if (!changed) return
		await this.writeJson(this.planPath(missionId), { items })
	}

	// --- Memory -----------------------------------------------------------

	async readMemory(who: RoleIdentity): Promise<string | null> {
		const path = this.memoryPath(who)
		if (!(await fileExists(path))) return null
		return readFile(path, "utf8")
	}

	async updateMemory(who: RoleIdentity, content: string): Promise<void> {
		await this.writeText(this.memoryPath(who), content)
	}

	// --- Human Input Inbox ------------------------------------------------

	async writeHumanInputRequest(
		missionId: string,
		request: HumanInputRequest,
	): Promise<void> {
		const existing = (await this.readHumanInputRequests(missionId)) ?? []
		const idx = existing.findIndex((r) => r.requestId === request.requestId)
		if (idx >= 0) {
			existing[idx] = request
		} else {
			existing.push(request)
		}
		await this.writeJson(this.humanInputPath(missionId), existing)
	}

	async readHumanInputRequests(
		missionId: string,
	): Promise<HumanInputRequest[]> {
		return (
			(await this.readJson<HumanInputRequest[]>(
				this.humanInputPath(missionId),
			)) ?? []
		)
	}

	// --- Status Report ----------------------------------------------------

	async writeStatusReport(
		missionId: string,
		report: StatusReport,
	): Promise<void> {
		await this.writeJson(this.statusReportPath(missionId), report)
	}

	async readStatusReport(missionId: string): Promise<StatusReport | null> {
		return this.readJson<StatusReport>(this.statusReportPath(missionId))
	}

	// --- Listing (ticket 08) ---------------------------------------------

	/**
	 * Read-only summary rows for all persisted missions (ticket 08). Scans the
	 * missions/ dir, reading each mission.json (+ plan.json for item counts).
	 * `updatedAt` is mission.json's mtime. No index, no filtering, no sort
	 * guarantee for v1 — the consumer filters/sorts. A corrupt mission.json
	 * fails loud (consistent with readJson): it is corrupt domain state, not
	 * "absent".
	 */
	async listMissions(): Promise<MissionSummary[]> {
		const missionsDir = join(this.root, "missions")
		if (!(await fileExists(missionsDir))) return []
		const entries = await readdir(missionsDir, { withFileTypes: true })
		const out: MissionSummary[] = []
		for (const entry of entries) {
			if (!entry.isDirectory()) continue
			const missionPath = join(missionsDir, entry.name, "mission.json")
			if (!(await fileExists(missionPath))) continue
			const mission = await this.readJson<Mission>(missionPath)
			if (!mission) continue
			const plan = await this.readJson<Plan>(
				join(missionsDir, entry.name, "plan.json"),
			)
			const { mtime } = await stat(missionPath)
			out.push({
				id: mission.id,
				title: mission.title,
				status: mission.status,
				repoPath: mission.repoPath,
				itemCounts: summarizeWorkItems(plan?.items ?? []),
				updatedAt: mtime.toISOString(),
			})
		}
		return out
	}

	// --- Paths ------------------------------------------------------------

	private missionDir(missionId: string): string {
		return join(this.root, "missions", missionId)
	}

	private missionPath(missionId: string): string {
		return join(this.missionDir(missionId), "mission.json")
	}

	private planPath(missionId: string): string {
		return join(this.missionDir(missionId), "plan.json")
	}

	private memoryPath(who: RoleIdentity): string {
		return join(this.missionDir(who.missionId), "memories", memoryFileName(who))
	}

	private humanInputPath(missionId: string): string {
		return join(this.missionDir(missionId), "human-input.json")
	}

	private statusReportPath(missionId: string): string {
		return join(this.missionDir(missionId), "status.json")
	}

	// --- Atomic IO helpers ------------------------------------------------

	/** Write JSON atomically (tmp + rename). Creates parent dirs lazily. */
	private async writeJson(path: string, value: unknown): Promise<void> {
		await this.writeText(path, JSON.stringify(value, null, 2))
	}

	/**
	 * Write text atomically: write `<path>.tmp` (same dir ⇒ same filesystem),
	 * then `rename` onto the final path. Creates parent dirs lazily.
	 */
	private async writeText(path: string, text: string): Promise<void> {
		await mkdir(dirname(path), { recursive: true })
		const tmp = `${path}.tmp`
		await writeFile(tmp, text, "utf8")
		await rename(tmp, path)
	}

	/**
	 * Read + parse JSON; `null` if the file does not exist. A corrupt file
	 * throws a descriptive error (naming the path) rather than being
	 * silently masked as "absent" — corruption is a real error, distinct
	 * from a missing mission/plan.
	 */
	private async readJson<T>(path: string): Promise<T | null> {
		if (!(await fileExists(path))) return null
		const text = await readFile(path, "utf8")
		try {
			return JSON.parse(text) as T
		} catch (err) {
			throw new Error(
				`Corrupt store file at ${path}: ${
					err instanceof Error ? err.message : String(err)
				}`,
			)
		}
	}
}
