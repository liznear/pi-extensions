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
// Store (tickets 02 / 04).
//
// The persistence interface the Orchestrator depends on. Constructed with the
// Orchestrator (swappable seam); consumers can substitute their own impl.
//
// Surface:
//   - Mission / Plan persistence (write + read).
//   - Domain-state writes: work item & mission status transitions.
//   - Memory (ticket 02): per-RoleIdentity keyed, full replace, null = none.
//
// Refs (worktree/branch) are NOT persisted here — ticket 06 D7: they are a pure
// function of identity and computed from git. The Store stays exactly Mission,
// Plan, Memory.
// ---------------------------------------------------------------------------

export interface Store {
	// --- Mission ---
	writeMission(mission: Mission): Promise<void>
	readMission(missionId: string): Promise<Mission | null>
	/** Update only the persisted mission's status (domain-state write). */
	writeMissionStatus(missionId: string, status: MissionStatus): Promise<void>
	/** Delete a mission and ALL its persisted state (mission/plan/memory/inbox). */
	deleteMission(missionId: string): Promise<void>

	// --- Plan ---
	writePlan(missionId: string, plan: Plan): Promise<void>
	readPlan(missionId: string): Promise<Plan | null>
	/** Update a single work item's status in the persisted plan. */
	writeWorkItemStatus(
		missionId: string,
		workItemId: number,
		status: WorkItemStatus,
	): Promise<void>

	// --- Memory (ticket 02) ---
	/** Library-internal: the Orchestrator reads memory to inject at session start. */
	readMemory(who: RoleIdentity): Promise<string | null>
	/** Backs the agent `updateMemory` tool; a full REPLACE of the role's doc. */
	updateMemory(who: RoleIdentity, content: string): Promise<void>

	// --- Listing (ticket 08) ---

	/** Read-only summary rows for all missions (derived from Mission + Plan). */
	listMissions(): Promise<MissionSummary[]>

	// --- Human Input Inbox (ticket 04 / 10) ---
	writeHumanInputRequest(
		missionId: string,
		request: HumanInputRequest,
	): Promise<void>
	readHumanInputRequests(missionId: string): Promise<HumanInputRequest[]>

	// --- Status Report (ticket 05 / 10) ---
	writeStatusReport(missionId: string, report: StatusReport): Promise<void>
	readStatusReport(missionId: string): Promise<StatusReport | null>
}

/** Stringify a RoleIdentity into a stable memory-doc key (structured at the interface). */
function memoryKey(who: RoleIdentity): string {
	const wi = who.workItemId ?? "_lead"
	return `${who.missionId}:${who.roleName}:${wi}`
}

// ---------------------------------------------------------------------------
// InMemoryStore — the default implementation (used by tests and the CLI).
// ---------------------------------------------------------------------------

export class InMemoryStore implements Store {
	private missions = new Map<string, Mission>()
	private plans = new Map<string, Plan>()
	private memories = new Map<string, string>()
	private humanInputs = new Map<string, HumanInputRequest[]>()
	private statusReports = new Map<string, StatusReport>()
	/** missionId → ISO ts of the last mission.json write (ticket 08 updatedAt). */
	private missionUpdatedAt = new Map<string, string>()

	async writeMission(mission: Mission): Promise<void> {
		this.missions.set(mission.id, mission)
		this.missionUpdatedAt.set(mission.id, new Date().toISOString())
	}

	async readMission(missionId: string): Promise<Mission | null> {
		return this.missions.get(missionId) ?? null
	}

	async writeMissionStatus(
		missionId: string,
		status: MissionStatus,
	): Promise<void> {
		const m = this.missions.get(missionId)
		if (!m) return
		this.missions.set(missionId, { ...m, status })
		this.missionUpdatedAt.set(missionId, new Date().toISOString())
	}

	async deleteMission(missionId: string): Promise<void> {
		this.missions.delete(missionId)
		this.plans.delete(missionId)
		this.humanInputs.delete(missionId)
		this.statusReports.delete(missionId)
		this.missionUpdatedAt.delete(missionId)
		// Memories are keyed `${missionId}:...`; drop every doc for this mission.
		for (const key of this.memories.keys()) {
			if (key.startsWith(`${missionId}:`)) this.memories.delete(key)
		}
	}

	async writePlan(missionId: string, plan: Plan): Promise<void> {
		this.plans.set(missionId, plan)
	}

	async readPlan(missionId: string): Promise<Plan | null> {
		return this.plans.get(missionId) ?? null
	}

	async writeWorkItemStatus(
		missionId: string,
		workItemId: number,
		status: WorkItemStatus,
	): Promise<void> {
		const plan = this.plans.get(missionId)
		if (!plan) return
		const items = plan.items.map((it) =>
			it.id === workItemId ? { ...it, status } : it,
		)
		this.plans.set(missionId, { items })
	}

	async readMemory(who: RoleIdentity): Promise<string | null> {
		return this.memories.get(memoryKey(who)) ?? null
	}

	async updateMemory(who: RoleIdentity, content: string): Promise<void> {
		this.memories.set(memoryKey(who), content)
	}

	async writeHumanInputRequest(
		missionId: string,
		request: HumanInputRequest,
	): Promise<void> {
		const existing = this.humanInputs.get(missionId) ?? []
		const idx = existing.findIndex((r) => r.requestId === request.requestId)
		if (idx >= 0) {
			existing[idx] = request
		} else {
			existing.push(request)
		}
		this.humanInputs.set(missionId, existing)
	}

	async readHumanInputRequests(
		missionId: string,
	): Promise<HumanInputRequest[]> {
		return this.humanInputs.get(missionId) ?? []
	}

	async writeStatusReport(
		missionId: string,
		report: StatusReport,
	): Promise<void> {
		this.statusReports.set(missionId, report)
	}

	async readStatusReport(missionId: string): Promise<StatusReport | null> {
		return this.statusReports.get(missionId) ?? null
	}

	async listMissions(): Promise<MissionSummary[]> {
		const out: MissionSummary[] = []
		for (const [id, mission] of this.missions) {
			const plan = this.plans.get(id)
			out.push({
				id: mission.id,
				title: mission.title,
				status: mission.status,
				repoPath: mission.repoPath,
				itemCounts: summarizeWorkItems(plan?.items ?? []),
				updatedAt: this.missionUpdatedAt.get(id) ?? new Date(0).toISOString(),
			})
		}
		return out
	}
}
