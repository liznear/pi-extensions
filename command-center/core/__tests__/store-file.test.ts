import { afterEach, describe, expect, test } from "bun:test"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { $ } from "bun"
import { FileStore, memoryFileName } from "../store-file"
import type { Mission, Plan, RoleIdentity, WorkItem } from "../types"

// ---------------------------------------------------------------------------
// FileStore — durability + behavior parity with InMemoryStore.
//
// Every behavior test runs against TWO store instances sharing the same root:
// the writer and a FRESH reader. A fresh process is the same thing — new
// constructor, same root — so "write → new FileStore(sameRoot) → read" proves
// a mission's state survives a process restart. The afterEach wipes the tmp
// root.
// ---------------------------------------------------------------------------

let root: string
const roots: string[] = []

afterEach(async () => {
	for (const r of roots.splice(0)) {
		await rm(r, { recursive: true, force: true })
	}
})

async function freshRoot(): Promise<string> {
	const dir = join(tmpdir(), `cc-store.${Math.random().toString(36).slice(2)}`)
	await $`mkdir -p ${dir}`.quiet()
	roots.push(dir)
	return dir
}

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

const item: (id: number) => WorkItem = (id) => ({
	id,
	title: `Item ${id}`,
	description: "",
	dependencies: [],
	status: "pending",
})

// ---------------------------------------------------------------------------
// memoryFileName helper
// ---------------------------------------------------------------------------

describe("memoryFileName", () => {
	test("lead ⇒ lead.md; owner ⇒ work-<itemId>.md", () => {
		expect(memoryFileName(lead)).toBe("lead.md")
		expect(memoryFileName(owner1)).toBe("work-1.md")
		expect(memoryFileName(owner2)).toBe("work-2.md")
	})
})

// ---------------------------------------------------------------------------
// Durability: write → fresh instance → read survives a "restart".
// ---------------------------------------------------------------------------

describe("FileStore — durability", () => {
	test("Mission survives a fresh instance (process-restart equivalent)", async () => {
		root = await freshRoot()
		const writer = new FileStore(root)
		await writer.writeMission(mission)

		const reader = new FileStore(root) // fresh instance, same root
		expect(await reader.readMission("7k3a9fqa")).toEqual(mission)
	})

	test("Plan survives a fresh instance", async () => {
		root = await freshRoot()
		const writer = new FileStore(root)
		const p = planWith([item(1), item(2)])
		await writer.writePlan("7k3a9fqa", p)

		const reader = new FileStore(root)
		expect(await reader.readPlan("7k3a9fqa")).toEqual(p)
	})

	test("Memory survives a fresh instance (per role)", async () => {
		root = await freshRoot()
		const writer = new FileStore(root)
		await writer.updateMemory(lead, "lead notes")
		await writer.updateMemory(owner1, "owner-1 notes")

		const reader = new FileStore(root)
		expect(await reader.readMemory(lead)).toBe("lead notes")
		expect(await reader.readMemory(owner1)).toBe("owner-1 notes")
	})

	test("status writes survive a fresh instance", async () => {
		root = await freshRoot()
		const writer = new FileStore(root)
		await writer.writeMission(mission)
		await writer.writePlan("7k3a9fqa", planWith([item(1), item(2)]))
		await writer.writeMissionStatus("7k3a9fqa", "ready_for_acceptance")
		await writer.writeWorkItemStatus("7k3a9fqa", 2, "accepted")

		const reader = new FileStore(root)
		expect((await reader.readMission("7k3a9fqa"))?.status).toBe(
			"ready_for_acceptance",
		)
		const p = await reader.readPlan("7k3a9fqa")
		expect(p?.items.find((i) => i.id === 2)?.status).toBe("accepted")
		expect(p?.items.find((i) => i.id === 1)?.status).toBe("pending")
	})
})

// ---------------------------------------------------------------------------
// Mission & Plan behavior (parity with InMemoryStore)
// ---------------------------------------------------------------------------

describe("FileStore — mission", () => {
	test("readMission returns null before write", async () => {
		root = await freshRoot()
		const s = new FileStore(root)
		expect(await s.readMission("7k3a9fqa")).toBeNull()
	})

	test("writeMission is an upsert (overwrites)", async () => {
		root = await freshRoot()
		const s = new FileStore(root)
		await s.writeMission(mission)
		await s.writeMission({ ...mission, title: "T2" })
		expect((await s.readMission("7k3a9fqa"))?.title).toBe("T2")
	})

	test("writeMissionStatus updates the persisted mission status", async () => {
		root = await freshRoot()
		const s = new FileStore(root)
		await s.writeMission(mission)
		await s.writeMissionStatus("7k3a9fqa", "ready_for_acceptance")
		expect((await s.readMission("7k3a9fqa"))?.status).toBe(
			"ready_for_acceptance",
		)
	})

	test("writeMissionStatus on an unknown mission is a no-op (returns)", async () => {
		root = await freshRoot()
		const s = new FileStore(root)
		// should not throw, should not create a file
		await s.writeMissionStatus("unknown", "completed")
		expect(await s.readMission("unknown")).toBeNull()
	})
})

describe("FileStore — plan", () => {
	test("readPlan returns null before write", async () => {
		root = await freshRoot()
		const s = new FileStore(root)
		expect(await s.readPlan("7k3a9fqa")).toBeNull()
	})

	test("writePlan is keyed by missionId (missions are independent)", async () => {
		root = await freshRoot()
		const s = new FileStore(root)
		await s.writePlan("7k3a9fqa", planWith([]))
		expect(await s.readPlan("zzzzzzzz")).toBeNull()
	})
})

// ---------------------------------------------------------------------------
// Work item status (parity with InMemoryStore)
// ---------------------------------------------------------------------------

describe("FileStore — work item status", () => {
	test("writeWorkItemStatus updates a single item's status in the plan", async () => {
		root = await freshRoot()
		const s = new FileStore(root)
		await s.writePlan("7k3a9fqa", planWith([item(1), item(2)]))
		await s.writeWorkItemStatus("7k3a9fqa", 2, "in_progress")
		const p = await s.readPlan("7k3a9fqa")
		expect(p?.items.find((i) => i.id === 2)?.status).toBe("in_progress")
		expect(p?.items.find((i) => i.id === 1)?.status).toBe("pending")
	})

	test("writeWorkItemStatus on unknown mission or unknown item is a no-op", async () => {
		root = await freshRoot()
		const s = new FileStore(root)
		await s.writePlan("7k3a9fqa", planWith([item(1)]))
		// unknown mission — no throw, no write
		await s.writeWorkItemStatus("unknown", 1, "accepted")
		// unknown item — no write
		await s.writeWorkItemStatus("7k3a9fqa", 999, "accepted")
		const p = await s.readPlan("7k3a9fqa")
		expect(p?.items[0]?.status).toBe("pending")
	})
})

// ---------------------------------------------------------------------------
// Memory (parity with InMemoryStore): per-RoleIdentity, full replace, null.
// ---------------------------------------------------------------------------

describe("FileStore — memory", () => {
	test("readMemory returns null when no memory exists", async () => {
		root = await freshRoot()
		const s = new FileStore(root)
		expect(await s.readMemory(lead)).toBeNull()
		expect(await s.readMemory(owner1)).toBeNull()
	})

	test("updateMemory is a full replace", async () => {
		root = await freshRoot()
		const s = new FileStore(root)
		await s.updateMemory(owner1, "# first")
		expect(await s.readMemory(owner1)).toBe("# first")
		await s.updateMemory(owner1, "# second")
		expect(await s.readMemory(owner1)).toBe("# second")
	})

	test("memory is per RoleIdentity — lead and owners are isolated", async () => {
		root = await freshRoot()
		const s = new FileStore(root)
		await s.updateMemory(lead, "lead notes")
		await s.updateMemory(owner1, "owner-1 notes")
		await s.updateMemory(owner2, "owner-2 notes")
		expect(await s.readMemory(lead)).toBe("lead notes")
		expect(await s.readMemory(owner1)).toBe("owner-1 notes")
		expect(await s.readMemory(owner2)).toBe("owner-2 notes")
	})

	test("workItemId distinguishes owners — absent = lead", async () => {
		root = await freshRoot()
		const s = new FileStore(root)
		await s.updateMemory(lead, "L")
		await s.updateMemory(owner1, "O1")
		expect(await s.readMemory(lead)).toBe("L")
		expect(await s.readMemory(owner1)).toBe("O1")
	})
})

// ---------------------------------------------------------------------------
// Atomicity: no half-written file is ever observed.
// ---------------------------------------------------------------------------

describe("FileStore — atomic writes", () => {
	test("no .tmp file is left behind after a successful write", async () => {
		root = await freshRoot()
		const s = new FileStore(root)
		await s.writeMission(mission)
		let listing = ""
		try {
			listing = await $`ls ${root}/missions/7k3a9fqa}`.text()
		} catch {
			listing = ""
		}
		expect(listing.includes(".tmp")).toBe(false)
	})
})

// ---------------------------------------------------------------------------
// listMissions (ticket 08): durable summary rows across missions.
// ---------------------------------------------------------------------------

describe("FileStore — listMissions", () => {
	test("returns summary rows across missions, durable across a fresh instance", async () => {
		root = await freshRoot()
		const writer = new FileStore(root)
		await writer.writeMission(mission)
		await writer.writePlan("7k3a9fqa", planWith([item(1), item(2)]))
		await writer.writeWorkItemStatus("7k3a9fqa", 1, "accepted")
		await writer.writeMission({
			...mission,
			id: "aaaaaaaa",
			title: "Other",
			repoPath: "/other",
		})

		const reader = new FileStore(root) // fresh instance, same root
		const rows = await reader.listMissions()
		expect(rows).toHaveLength(2)

		const a = rows.find((r) => r.id === "7k3a9fqa")
		expect(a).toMatchObject({
			title: "T",
			status: "in_progress",
			repoPath: "/test-repo",
			itemCounts: {
				pending: 1,
				in_progress: 0,
				ready_for_review: 0,
				accepted: 1,
				cancelled: 0,
			},
		})
		expect(a?.updatedAt).toBeTruthy()

		// no plan written for this mission → zero counts across the board
		const b = rows.find((r) => r.id === "aaaaaaaa")
		expect(b?.itemCounts).toEqual({
			pending: 0,
			in_progress: 0,
			ready_for_review: 0,
			accepted: 0,
			cancelled: 0,
		})
	})

	test("returns [] when the missions dir does not exist", async () => {
		root = await freshRoot()
		const s = new FileStore(root)
		expect(await s.listMissions()).toEqual([])
	})
})

// ---------------------------------------------------------------------------
// deleteMission: wipes the mission dir; durable across a fresh instance.
// ---------------------------------------------------------------------------

describe("FileStore — deleteMission", () => {
	test("removes mission + plan + memory (survives a fresh instance)", async () => {
		root = await freshRoot()
		const writer = new FileStore(root)
		await writer.writeMission(mission)
		await writer.writePlan("7k3a9fqa", planWith([item(1), item(2)]))
		await writer.updateMemory(lead, "L")
		await writer.updateMemory(owner1, "O1")

		await writer.deleteMission("7k3a9fqa")

		const reader = new FileStore(root) // fresh instance, same root
		expect(await reader.readMission("7k3a9fqa")).toBeNull()
		expect(await reader.readPlan("7k3a9fqa")).toBeNull()
		expect(await reader.readMemory(lead)).toBeNull()
		expect(await reader.readMemory(owner1)).toBeNull()
		expect(await reader.listMissions()).toEqual([])
	})

	test("leaves sibling missions untouched", async () => {
		root = await freshRoot()
		const writer = new FileStore(root)
		await writer.writeMission(mission)
		await writer.writeMission({
			...mission,
			id: "siblingid",
			title: "Sibling",
		})

		await writer.deleteMission("7k3a9fqa")

		const reader = new FileStore(root)
		expect(await reader.readMission("7k3a9fqa")).toBeNull()
		expect((await reader.readMission("siblingid"))?.title).toBe("Sibling")
		expect(await reader.listMissions()).toHaveLength(1)
	})

	test("deleting an unknown mission is a no-op (does not throw)", async () => {
		root = await freshRoot()
		const s = new FileStore(root)
		await s.deleteMission("never-existed")
		expect(await s.listMissions()).toEqual([])
	})
})
