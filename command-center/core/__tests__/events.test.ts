import { describe, expect, test } from "bun:test"
import type { AssistantMessage } from "@earendil-works/pi-ai"
import { type EmittableEvent, type Event, EventBus } from "../events"
import type { Mission, Plan } from "../types"

// A throwaway AssistantMessage for the message-ended event shape. We cast
// rather than construct so the test doesn't couple to SDK-internal Usage
// fields; the events module only forwards it opaquely.
function fakeAssistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "hi" }],
		api: "anthropic",
		provider: "anthropic",
		model: "test-model",
		usage: {} as AssistantMessage["usage"],
		stopReason: "stop",
		timestamp: 0,
	} as AssistantMessage
}

const mission: Mission = {
	id: "7k3a9fqa",
	repoPath: "/test-repo",
	title: "T",
	description: "D",
	acceptanceCriteria: [],
	status: "in_progress",
}
const plan: Plan = { items: [] }

describe("EventBus", () => {
	test("emit stamps ts and a monotonic seq", () => {
		const bus = new EventBus()
		const before = Date.now()
		const e1 = bus.emit({
			type: "mission-defined",
			missionId: "aaaaaaaa",
			mission,
		})
		const e2 = bus.emit({ type: "plan-written", missionId: "aaaaaaaa", plan })
		const after = Date.now()

		expect(e1.seq).toBe(0)
		expect(e2.seq).toBe(1)
		expect(e2.seq).toBeGreaterThan(e1.seq)
		expect(typeof e1.ts).toBe("number")
		expect(e1.ts).toBeGreaterThanOrEqual(before)
		expect(e1.ts).toBeLessThanOrEqual(after)
	})

	test("subscribe receives stamped events", () => {
		const bus = new EventBus()
		const received: Event[] = []
		bus.subscribe((e) => received.push(e))
		bus.emit({ type: "mission-defined", missionId: "aaaaaaaa", mission })

		expect(received).toHaveLength(1)
		const got = received[0]
		expect(got?.type).toBe("mission-defined")
		expect(got?.seq).toBe(0)
		if (got && got.type === "mission-defined") {
			expect(got.mission).toBe(mission)
		} else {
			expect.unreachable("should be mission-defined")
		}
	})

	test("multiple listeners all receive the same stamped event", () => {
		const bus = new EventBus()
		const a: Event[] = []
		const b: Event[] = []
		bus.subscribe((e) => a.push(e))
		bus.subscribe((e) => b.push(e))
		const emitted = bus.emit({
			type: "mission-defined",
			missionId: "aaaaaaaa",
			mission,
		})

		expect(a).toHaveLength(1)
		expect(b).toHaveLength(1)
		// same object identity for all listeners
		expect(a[0]).toBe(emitted)
		expect(b[0]).toBe(emitted)
	})

	test("unsubscribe stops receiving", () => {
		const bus = new EventBus()
		const received: Event[] = []
		const off = bus.subscribe((e) => received.push(e))
		bus.emit({ type: "mission-defined", missionId: "aaaaaaaa", mission })
		off()
		bus.emit({ type: "plan-written", missionId: "aaaaaaaa", plan })

		expect(received).toHaveLength(1)
	})

	test("seq is per-bus independent", () => {
		const a = new EventBus()
		const b = new EventBus()
		a.emit({ type: "mission-defined", missionId: "aaaaaaaa", mission })
		const bFirst = b.emit({
			type: "mission-defined",
			missionId: "aaaaaaaa",
			mission,
		})
		expect(bFirst.seq).toBe(0)
	})

	test("every event type round-trips through emit with correct shape", () => {
		const bus = new EventBus()
		const seen: Event[] = []
		bus.subscribe((e) => seen.push(e))

		const events: EmittableEvent[] = [
			{ type: "mission-defined", missionId: "aaaaaaaa", mission },
			{ type: "plan-written", missionId: "aaaaaaaa", plan },
			{
				type: "work-item-status-changed",
				missionId: "aaaaaaaa",
				workItemId: 1,
				from: "pending",
				to: "in_progress",
				causedBy: { roleName: "mission_lead" },
			},
			{
				type: "mission-status-changed",
				missionId: "aaaaaaaa",
				from: "in_progress",
				to: "ready_for_acceptance",
			},
			{
				type: "memory-updated",
				missionId: "aaaaaaaa",
				roleName: "mission_lead",
				content: "# notes",
			},
			{
				type: "session-started",
				missionId: "aaaaaaaa",
				roleName: "mission_lead",
				sessionId: "sess-1",
			},
			{
				type: "session-ended",
				missionId: "aaaaaaaa",
				roleName: "work_item_owner",
				workItemId: 1,
				sessionId: "sess-2",
			},
			{
				type: "message-delta",
				missionId: "aaaaaaaa",
				roleName: "mission_lead",
				delta: "hel",
			},
			{
				type: "reasoning-delta",
				missionId: "aaaaaaaa",
				roleName: "mission_lead",
				delta: "think",
			},
			{
				type: "tool-call-started",
				missionId: "aaaaaaaa",
				roleName: "work_item_owner",
				workItemId: 2,
				toolCallId: "tc1",
				toolName: "bash",
				args: { command: "ls" },
			},
			{
				type: "tool-call-ended",
				missionId: "aaaaaaaa",
				roleName: "work_item_owner",
				workItemId: 2,
				toolCallId: "tc1",
				toolName: "bash",
				result: "out",
				isError: false,
			},
			{
				type: "message-ended",
				missionId: "aaaaaaaa",
				roleName: "mission_lead",
				message: fakeAssistantMessage(),
			},
		]

		for (const e of events) bus.emit(e)

		expect(seen).toHaveLength(12)
		expect(seen.map((e) => e.seq)).toEqual([
			0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
		])
		// every event got stamped
		for (const e of seen) {
			expect(typeof e.ts).toBe("number")
			expect(typeof e.seq).toBe("number")
		}
		// discriminated union narrows on type
		const first = seen[0]
		if (first && first.type === "mission-defined") {
			expect(first.mission).toBe(mission)
		} else {
			expect.unreachable("should be mission-defined")
		}
	})

	test("causedBy is optional and carries role identity when present", () => {
		const bus = new EventBus()
		const seen: Event[] = []
		bus.subscribe((e) => seen.push(e))
		bus.emit({
			type: "work-item-status-changed",
			missionId: "aaaaaaaa",
			workItemId: 1,
			from: "ready_for_review",
			to: "in_progress",
			// no causedBy
		})
		bus.emit({
			type: "work-item-status-changed",
			missionId: "aaaaaaaa",
			workItemId: 1,
			from: "in_progress",
			to: "ready_for_review",
			causedBy: { roleName: "work_item_owner", workItemId: 1 },
		})

		expect(seen).toHaveLength(2)
		const e0 = seen[0]
		const e1 = seen[1]
		if (e0?.type === "work-item-status-changed")
			expect(e0.causedBy).toBeUndefined()
		else expect.unreachable()
		if (e1?.type === "work-item-status-changed") {
			expect(e1.causedBy).toEqual({
				roleName: "work_item_owner",
				workItemId: 1,
			})
		} else expect.unreachable()
	})
})

describe("Event type narrowing", () => {
	test("EmittableEvent omits ts and seq", () => {
		// type-level check via a value: emitting requires no ts/seq
		const bus = new EventBus()
		const e: EmittableEvent = {
			type: "memory-updated",
			missionId: "aaaaaaaa",
			roleName: "work_item_owner",
			workItemId: 3,
			content: "x",
		}
		const stamped = bus.emit(e)
		expect(stamped.seq).toBe(0)
		expect(stamped.ts).toBeGreaterThanOrEqual(0)
	})
})
