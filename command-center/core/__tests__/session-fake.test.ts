import { describe, expect, test } from "bun:test"
import { type Event, EventBus } from "../events"
import {
	buildSystemPrompt,
	FakeRoleSession,
	FakeSessionRunner,
} from "../session"
import { InMemoryStore } from "../store"
import type { RoleIdentity } from "../types"

const lead: RoleIdentity = { missionId: "7k3a9fqa", roleName: "mission_lead" }
const owner: RoleIdentity = {
	missionId: "7k3a9fqa",
	roleName: "work_item_owner",
	workItemId: 1,
}

function capture(bus: EventBus): Event[] {
	const events: Event[] = []
	bus.subscribe((e) => events.push(e))
	return events
}

describe("buildSystemPrompt (memory injection)", () => {
	test("no memory → returns base prompt unchanged", async () => {
		const store = new InMemoryStore()
		const build = buildSystemPrompt("You are the lead.", store)
		expect(await build(lead)).toBe("You are the lead.")
	})

	test("with memory → appends a Memory section", async () => {
		const store = new InMemoryStore()
		await store.updateMemory(owner, "# notes\n- did X")
		const build = buildSystemPrompt("You are the owner.", store)
		const prompt = await build(owner)
		expect(prompt).toContain("You are the owner.")
		expect(prompt).toContain("## Your Memory")
		expect(prompt).toContain("# notes\n- did X")
	})

	test("memory is per-role (lead and owner don't mix)", async () => {
		const store = new InMemoryStore()
		await store.updateMemory(lead, "LEAD")
		await store.updateMemory(owner, "OWNER")
		const build = buildSystemPrompt("base", store)
		expect(await build(lead)).toContain("LEAD")
		expect(await build(lead)).not.toContain("OWNER")
		expect(await build(owner)).toContain("OWNER")
		expect(await build(owner)).not.toContain("LEAD")
	})
})

describe("FakeSessionRunner", () => {
	test("startOrResume emits session-started and returns a session", async () => {
		const bus = new EventBus()
		const events = capture(bus)
		const runner = new FakeSessionRunner(bus)

		const session = await runner.startOrResume(lead, "/tmp", "prompt", [])

		expect(session).toBeInstanceOf(FakeRoleSession)
		const started = events.find((e) => e.type === "session-started")
		expect(started).toBeDefined()
		if (started?.type === "session-started") {
			expect(started.roleName).toBe("mission_lead")
			expect(started.sessionId).toBe(session.sessionId)
		}
	})

	test("startOrResume is idempotent per role (resume returns the SAME session)", async () => {
		const bus = new EventBus()
		const runner = new FakeSessionRunner(bus)

		const s1 = await runner.startOrResume(owner, "/tmp", "prompt", [])
		const s2 = await runner.startOrResume(owner, "/tmp", "prompt", [])
		expect(s2).toBe(s1) // resume, not a fresh session
	})

	test("different roles get different sessions", async () => {
		const bus = new EventBus()
		const runner = new FakeSessionRunner(bus)
		const s1 = await runner.startOrResume(lead, "/tmp", "prompt", [])
		const s2 = await runner.startOrResume(owner, "/tmp", "prompt", [])
		expect(s1).not.toBe(s2)
	})

	test("prompt records text and invokes the onPrompt hook", async () => {
		const bus = new EventBus()
		const calls: string[] = []
		const runner = new FakeSessionRunner(bus, {
			onPrompt: (_s, text) => {
				calls.push(text)
			},
		})
		const session = (await runner.startOrResume(
			owner,
			"/tmp",
			"p",
			[],
		)) as FakeRoleSession
		await session.prompt("do the thing")
		expect(calls).toEqual(["do the thing"])
		expect(session.prompts).toEqual(["do the thing"])
	})

	test("session.emit pushes normalized events onto the bus", async () => {
		const bus = new EventBus()
		const events = capture(bus)
		const runner = new FakeSessionRunner(bus)
		const session = (await runner.startOrResume(
			owner,
			"/tmp",
			"p",
			[],
		)) as FakeRoleSession

		session.emit({
			type: "tool-call-ended",
			missionId: "7k3a9fqa",
			roleName: "work_item_owner",
			workItemId: 1,
			toolCallId: "tc1",
			toolName: "request_review",
			result: { details: { kind: "request_review", summary: "done" } },
			isError: false,
		})

		const e = events.find((ev) => ev.type === "tool-call-ended")
		expect(e).toBeDefined()
	})
})
