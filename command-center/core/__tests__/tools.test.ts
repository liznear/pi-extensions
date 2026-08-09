import { describe, expect, test } from "bun:test"
import type {
	AgentToolResult,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent"
import { type Event, EventBus } from "../events"
import { InMemoryStore } from "../store"
import { createUpdateMemoryTool } from "../tools/memory"
import { createDefineMissionTool } from "../tools/mission"
import { createWritePlanTool } from "../tools/plan"
import {
	type AcceptAndMerge,
	createRequestReviewTool,
	createReviewWorkItemTool,
} from "../tools/review"
import type { Mission, Plan, RoleIdentity, WorkItemStatus } from "../types"

// We exercise each tool's `execute` directly with a real InMemoryStore +
// EventBus, asserting store state, emitted events, and the agent-facing result.

const lead: RoleIdentity = { missionId: "7k3a9fqa", roleName: "mission_lead" }
const owner1: RoleIdentity = {
	missionId: "7k3a9fqa",
	roleName: "work_item_owner",
	workItemId: 1,
}

// The SDK's tool.execute takes 5 args: (toolCallId, params, signal, onUpdate, ctx).
// Tests pass undefined for the optional signal/onUpdate/ctx (not exercised here).
// We type against ToolDefinition and use `any` for params — the helper
// intentionally erases the per-tool generic so call sites stay readable.
async function run<P>(
	tool: ToolDefinition,
	params: P,
): Promise<AgentToolResult<unknown>> {
	// signal, onUpdate, ctx are not exercised by these tests.
	return tool.execute(
		"tc1",
		params as never,
		undefined as never,
		undefined as never,
		undefined as never,
	) as Promise<AgentToolResult<unknown>>
}

// Tiny helper to capture all events off a bus.
function capture(bus: EventBus): Event[] {
	const events: Event[] = []
	bus.subscribe((e) => events.push(e))
	return events
}

describe("define_mission tool", () => {
	test("writes mission with the closure id (status pending when no stub exists) and emits mission-defined", async () => {
		const store = new InMemoryStore()
		const bus = new EventBus()
		const events = capture(bus)
		const tool = createDefineMissionTool(store, bus, lead, "/test-repo")
		const res = (await run(tool, {
			title: "T",
			description: "D",
			acceptanceCriteria: ["c1"],
		})) as AgentToolResult<{ mission: Mission }>

		const mission = (await store.readMission("7k3a9fqa"))!
		expect(mission.id).toBe("7k3a9fqa") // from closure, not agent
		expect(mission.title).toBe("T")
		// define_mission preserves the lifecycle status: with no stub the mission
		// is `pending` (launch transitions to in_progress).
		expect(mission.status).toBe("pending")
		expect(res.details.mission.id).toBe("7k3a9fqa")
		expect(events.filter((e) => e.type === "mission-defined")).toHaveLength(1)
	})

	test("preserves an existing mission's status (stub stays pending until launch)", async () => {
		const store = new InMemoryStore()
		const bus = new EventBus()
		await store.writeMission({
			id: "7k3a9fqa",
			repoPath: "/test-repo",
			title: "(New Mission)",
			description: "",
			acceptanceCriteria: [],
			status: "pending",
		})
		const tool = createDefineMissionTool(store, bus, lead, "/test-repo")
		await run(tool, {
			title: "T",
			description: "D",
			acceptanceCriteria: ["c1"],
		})
		expect((await store.readMission("7k3a9fqa"))?.status).toBe("pending")

		// And an already-launched mission keeps in_progress across redefinitions.
		await store.writeMissionStatus("7k3a9fqa", "in_progress")
		await run(tool, {
			title: "T2",
			description: "D2",
			acceptanceCriteria: ["c2"],
		})
		expect((await store.readMission("7k3a9fqa"))?.status).toBe("in_progress")
	})
})

describe("write_plan tool", () => {
	test("persists the merged plan (append-only) and emits plan-written", async () => {
		const store = new InMemoryStore()
		const bus = new EventBus()
		const events = capture(bus)
		const tool = createWritePlanTool(store, bus, lead)

		await run(tool, {
			items: [{ title: "A", description: "a", dependencies: [] }],
		})
		const plan = (await store.readPlan("7k3a9fqa"))!
		expect(plan.items).toHaveLength(1)
		expect(plan.items[0]!.id).toBe(1)
		expect(events.some((e) => e.type === "plan-written")).toBe(true)
	})

	test("is keyed by mission (lead's RoleIdentity)", async () => {
		const store = new InMemoryStore()
		const bus = new EventBus()
		const tool = createWritePlanTool(store, bus, lead)
		await run(tool, {
			items: [{ title: "A", description: "", dependencies: [] }],
		})
		expect(await store.readPlan("other")).toBeNull()
	})
})

describe("update_memory tool", () => {
	test("full-replaces the role's memory and emits memory-updated with the content", async () => {
		const store = new InMemoryStore()
		const bus = new EventBus()
		const events = capture(bus)
		const tool = createUpdateMemoryTool(store, bus, owner1)

		await run(tool, { content: "# first" })
		expect(await store.readMemory(owner1)).toBe("# first")
		await run(tool, { content: "# second" })
		expect(await store.readMemory(owner1)).toBe("# second") // replace, not append

		const memEvents = events.filter((e) => e.type === "memory-updated")
		expect(memEvents).toHaveLength(2)
		const last = memEvents[1]
		if (last?.type === "memory-updated") {
			expect(last.content).toBe("# second")
			expect(last.roleName).toBe("work_item_owner")
			expect(last.workItemId).toBe(1)
		} else expect.unreachable()
	})

	test("owner and lead memory are isolated (keyed by RoleIdentity)", async () => {
		const store = new InMemoryStore()
		const bus = new EventBus()
		const ownerTool = createUpdateMemoryTool(store, bus, owner1)
		const leadTool = createUpdateMemoryTool(store, bus, lead)
		await run(ownerTool, { content: "O" })
		await run(leadTool, { content: "L" })
		expect(await store.readMemory(owner1)).toBe("O")
		expect(await store.readMemory(lead)).toBe("L")
	})
})

describe("request_review tool", () => {
	test("returns a request_review detail + terminate:true", async () => {
		const tool = createRequestReviewTool(owner1)
		const res = await run(tool, { summary: "did X in file f" })
		expect(res.terminate).toBe(true)
		expect(res.details).toEqual({
			kind: "request_review",
			workItemId: 1,
			summary: "did X in file f",
		})
	})

	test("throws if called by a non-owner role (defensive)", async () => {
		const tool = createRequestReviewTool(lead)
		await expect(run(tool, { summary: "x" })).rejects.toThrow(/non-owner/)
	})
})

describe("review_work_item tool", () => {
	async function seedPlan(
		store: InMemoryStore,
		status: WorkItemStatus,
	): Promise<Plan> {
		await store.writePlan("7k3a9fqa", {
			items: [
				{
					id: 1,
					title: "Item 1",
					description: "",
					dependencies: [],
					status,
				},
			],
		})
		return (await store.readPlan("7k3a9fqa"))!
	}

	test("accept (clean merge) → status accepted, emits work-item-status-changed", async () => {
		const store = new InMemoryStore()
		const bus = new EventBus()
		const events = capture(bus)
		await seedPlan(store, "ready_for_review")
		const acceptAndMerge: AcceptAndMerge = async () => ({ ok: true })
		const tool = createReviewWorkItemTool(store, bus, lead, acceptAndMerge)

		const res = await run(tool, { workItemId: 1, decision: "accept" })
		expect(res.details).toEqual({
			kind: "review_work_item",
			workItemId: 1,
			decision: "accept",
			applied: true,
		})
		const plan = (await store.readPlan("7k3a9fqa"))!
		expect(plan.items[0]!.status).toBe("accepted")
		expect(events.some((e) => e.type === "work-item-status-changed")).toBe(true)
	})

	test("accept (conflict) → throws naming files, status stays ready_for_review", async () => {
		const store = new InMemoryStore()
		const bus = new EventBus()
		await seedPlan(store, "ready_for_review")
		const acceptAndMerge: AcceptAndMerge = async () => ({
			ok: false,
			conflictingFiles: ["a.ts", "b.ts"],
		})
		const tool = createReviewWorkItemTool(store, bus, lead, acceptAndMerge)

		await expect(
			run(tool, { workItemId: 1, decision: "accept" }),
		).rejects.toThrow(/a\.ts, b\.ts/)
		const plan = (await store.readPlan("7k3a9fqa"))!
		expect(plan.items[0]!.status).toBe("ready_for_review") // unchanged
	})

	test("rework (with feedback) → status in_progress, carries feedback", async () => {
		const store = new InMemoryStore()
		const bus = new EventBus()
		await seedPlan(store, "ready_for_review")
		const acceptAndMerge: AcceptAndMerge = async () => ({ ok: true })
		const tool = createReviewWorkItemTool(store, bus, lead, acceptAndMerge)

		const res = await run(tool, {
			workItemId: 1,
			decision: "rework",
			feedback: "fix the tests",
		})
		const details = res.details as { applied: boolean; feedback?: string }
		expect(details.applied).toBe(true)
		expect(details.feedback).toBe("fix the tests")
		const plan = (await store.readPlan("7k3a9fqa"))!
		expect(plan.items[0]!.status).toBe("in_progress")
	})

	test("rework WITHOUT feedback → throws (feedback required)", async () => {
		const store = new InMemoryStore()
		const bus = new EventBus()
		await seedPlan(store, "ready_for_review")
		const acceptAndMerge: AcceptAndMerge = async () => ({ ok: true })
		const tool = createReviewWorkItemTool(store, bus, lead, acceptAndMerge)

		await expect(
			run(tool, { workItemId: 1, decision: "rework" }),
		).rejects.toThrow(/feedback/)
		const plan = (await store.readPlan("7k3a9fqa"))!
		expect(plan.items[0]!.status).toBe("ready_for_review") // unchanged
	})

	test("cancel → status cancelled", async () => {
		const store = new InMemoryStore()
		const bus = new EventBus()
		await seedPlan(store, "ready_for_review")
		const acceptAndMerge: AcceptAndMerge = async () => ({ ok: true })
		const tool = createReviewWorkItemTool(store, bus, lead, acceptAndMerge)

		await run(tool, {
			workItemId: 1,
			decision: "cancel",
			feedback: "wrong scope",
		})
		const plan = (await store.readPlan("7k3a9fqa"))!
		expect(plan.items[0]!.status).toBe("cancelled")
	})
})
