import { describe, expect, test } from "bun:test"
import { InMemoryStore } from "../store"
import type { Mission, Plan, RoleIdentity, WorkItem } from "../types"

// Helpers ------------------------------------------------------------------

const mission: Mission = {
	id: "7k3a9fqa",
	repoPath: "/test-repo",
	title: "T",
	description: "D",
	acceptanceCriteria: [],
	status: "in_progress",
}

function planWith(items: WorkItem[]): Plan {
	return { items }
}

const lead: RoleIdentity = { missionId: "7k3a9fqa", roleName: "mission_lead" }
const owner1: RoleIdentity = {
	missionId: "7k3a9fqa",
	roleName: "work_item_owner",
	workItemId: 1,
}
const owner2: RoleIdentity = {
	missionId: "7k3a9fqa",
	roleName: "work_item_owner",
	workItemId: 2,
}

// ---------------------------------------------------------------------------
// Mission & Plan
// ---------------------------------------------------------------------------

describe("InMemoryStore — mission", () => {
	test("writeMission stores and readMission returns it", async () => {
		const s = new InMemoryStore()
		expect(await s.readMission("7k3a9fqa")).toBeNull()
		await s.writeMission(mission)
		expect(await s.readMission("7k3a9fqa")).toEqual(mission)
	})

	test("writeMission is an upsert (overwrites)", async () => {
		const s = new InMemoryStore()
		await s.writeMission(mission)
		await s.writeMission({ ...mission, title: "T2" })
		expect((await s.readMission("7k3a9fqa"))?.title).toBe("T2")
	})

	test("writeMissionStatus updates the persisted mission status", async () => {
		const s = new InMemoryStore()
		await s.writeMission(mission)
		await s.writeMissionStatus("7k3a9fqa", "ready_for_acceptance")
		expect((await s.readMission("7k3a9fqa"))?.status).toBe(
			"ready_for_acceptance",
		)
	})

	test("writeMissionStatus on an unknown mission is a no-op (returns)", async () => {
		const s = new InMemoryStore()
		// should not throw
		await s.writeMissionStatus("unknown", "completed")
		expect(await s.readMission("unknown")).toBeNull()
	})
})

describe("InMemoryStore — plan", () => {
	test("writePlan stores and readPlan returns it", async () => {
		const s = new InMemoryStore()
		const p = planWith([
			{
				id: 1,
				title: "A",
				description: "",
				dependencies: [],
				status: "pending",
			},
		])
		expect(await s.readPlan("7k3a9fqa")).toBeNull()
		await s.writePlan("7k3a9fqa", p)
		expect(await s.readPlan("7k3a9fqa")).toEqual(p)
	})

	test("writePlan is keyed by missionId (missions are independent)", async () => {
		const s = new InMemoryStore()
		await s.writePlan("7k3a9fqa", planWith([]))
		expect(await s.readPlan("zzzzzzzz")).toBeNull()
	})
})

// ---------------------------------------------------------------------------
// Work item status (ticket 04: domain-state status writes)
// ---------------------------------------------------------------------------

describe("InMemoryStore — work item status", () => {
	test("writeWorkItemStatus updates a single item's status in the plan", async () => {
		const s = new InMemoryStore()
		await s.writePlan(
			"7k3a9fqa",
			planWith([
				{
					id: 1,
					title: "A",
					description: "",
					dependencies: [],
					status: "pending",
				},
				{
					id: 2,
					title: "B",
					description: "",
					dependencies: [],
					status: "pending",
				},
			]),
		)
		await s.writeWorkItemStatus("7k3a9fqa", 2, "in_progress")
		const p = await s.readPlan("7k3a9fqa")
		expect(p?.items.find((i) => i.id === 2)?.status).toBe("in_progress")
		// other items untouched
		expect(p?.items.find((i) => i.id === 1)?.status).toBe("pending")
	})

	test("writeWorkItemStatus on unknown mission or unknown item is a no-op", async () => {
		const s = new InMemoryStore()
		await s.writePlan(
			"7k3a9fqa",
			planWith([
				{
					id: 1,
					title: "A",
					description: "",
					dependencies: [],
					status: "pending",
				},
			]),
		)
		// unknown mission
		await s.writeWorkItemStatus("unknown", 1, "accepted")
		// unknown item
		await s.writeWorkItemStatus("7k3a9fqa", 999, "accepted")
		const p = await s.readPlan("7k3a9fqa")
		expect(p?.items[0]?.status).toBe("pending")
	})
})

// ---------------------------------------------------------------------------
// Memory (ticket 02): per-RoleIdentity keyed, full replace, null = none.
// ---------------------------------------------------------------------------

describe("InMemoryStore — memory", () => {
	test("readMemory returns null when no memory exists", async () => {
		const s = new InMemoryStore()
		expect(await s.readMemory(lead)).toBeNull()
		expect(await s.readMemory(owner1)).toBeNull()
	})

	test("updateMemory is a full replace", async () => {
		const s = new InMemoryStore()
		await s.updateMemory(owner1, "# first")
		expect(await s.readMemory(owner1)).toBe("# first")
		await s.updateMemory(owner1, "# second")
		expect(await s.readMemory(owner1)).toBe("# second")
	})

	test("memory is per RoleIdentity — lead and owners are isolated", async () => {
		const s = new InMemoryStore()
		await s.updateMemory(lead, "lead notes")
		await s.updateMemory(owner1, "owner-1 notes")
		await s.updateMemory(owner2, "owner-2 notes")
		expect(await s.readMemory(lead)).toBe("lead notes")
		expect(await s.readMemory(owner1)).toBe("owner-1 notes")
		expect(await s.readMemory(owner2)).toBe("owner-2 notes")
	})

	test("workItemId distinguishes owners — absent = lead", async () => {
		const s = new InMemoryStore()
		// lead identity: roleName mission_lead, no workItemId
		await s.updateMemory(lead, "L")
		// an owner with the same missionId but a workItemId is a different doc
		await s.updateMemory(owner1, "O1")
		expect(await s.readMemory(lead)).toBe("L")
		expect(await s.readMemory(owner1)).toBe("O1")
	})
})

// ---------------------------------------------------------------------------
// listMissions (ticket 08): summary rows derived from Mission + Plan.
// ---------------------------------------------------------------------------

describe("InMemoryStore — listMissions", () => {
	test("returns a summary row per mission with derived counts + updatedAt", async () => {
		const s = new InMemoryStore()
		await s.writeMission(mission)
		await s.writePlan(
			"7k3a9fqa",
			planWith([
				{
					id: 1,
					title: "A",
					description: "",
					dependencies: [],
					status: "pending",
				},
				{
					id: 2,
					title: "B",
					description: "",
					dependencies: [],
					status: "in_progress",
				},
				{
					id: 3,
					title: "C",
					description: "",
					dependencies: [],
					status: "accepted",
				},
			]),
		)
		const rows = await s.listMissions()
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({
			id: "7k3a9fqa",
			title: "T",
			status: "in_progress",
			repoPath: "/test-repo",
			itemCounts: {
				pending: 1,
				in_progress: 1,
				ready_for_review: 0,
				accepted: 1,
				cancelled: 0,
			},
		})
		expect(rows[0]!.updatedAt).toBeTruthy()
	})

	test("itemCounts are zero across the board when no plan exists", async () => {
		const s = new InMemoryStore()
		await s.writeMission(mission)
		const rows = await s.listMissions()
		expect(rows[0]!.itemCounts).toEqual({
			pending: 0,
			in_progress: 0,
			ready_for_review: 0,
			accepted: 0,
			cancelled: 0,
		})
	})

	test("a status write is reflected in the summary row", async () => {
		const s = new InMemoryStore()
		await s.writeMission(mission)
		await s.writeMissionStatus("7k3a9fqa", "ready_for_acceptance")
		const rows = await s.listMissions()
		expect(rows[0]!.status).toBe("ready_for_acceptance")
	})
})

// ---------------------------------------------------------------------------
// deleteMission: removes mission + plan + memory; leaves others untouched.
// ---------------------------------------------------------------------------

describe("InMemoryStore — deleteMission", () => {
	test("removes the mission, its plan, and every role's memory", async () => {
		const s = new InMemoryStore()
		await s.writeMission(mission)
		await s.writePlan(
			"7k3a9fqa",
			planWith([
				{
					id: 1,
					title: "A",
					description: "",
					dependencies: [],
					status: "pending",
				},
			]),
		)
		await s.updateMemory(lead, "L")
		await s.updateMemory(owner1, "O1")

		await s.deleteMission("7k3a9fqa")

		expect(await s.readMission("7k3a9fqa")).toBeNull()
		expect(await s.readPlan("7k3a9fqa")).toBeNull()
		expect(await s.readMemory(lead)).toBeNull()
		expect(await s.readMemory(owner1)).toBeNull()
		expect(await s.listMissions()).toEqual([])
	})

	test("leaves other missions untouched", async () => {
		const s = new InMemoryStore()
		await s.writeMission(mission)
		await s.writeMission({ ...mission, id: "othermiss", title: "Other" })
		await s.updateMemory(owner1, "O1")

		await s.deleteMission("7k3a9fqa")

		expect(await s.readMission("7k3a9fqa")).toBeNull()
		expect((await s.readMission("othermiss"))?.title).toBe("Other")
		expect(await s.listMissions()).toHaveLength(1)
	})

	test("deleting an unknown mission is a no-op (does not throw)", async () => {
		const s = new InMemoryStore()
		await s.deleteMission("never-existed")
		expect(await s.listMissions()).toEqual([])
	})
})
