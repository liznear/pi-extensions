import { describe, expect, test } from "bun:test"
import { Orchestrator } from "../orchestrator"
import { FakeSessionRunner } from "../session"
import { InMemoryStore } from "../store"
import { FakeWorktreeProvider } from "../worktree/provisioner"

describe("Orchestrator — Concurrency Layer (Ticket 12)", () => {
	test("bounds global owner processes across multiple missions via Semaphore", async () => {
		const store = new InMemoryStore()
		const wt = new FakeWorktreeProvider()

		let activeOwnerTurns = 0
		let maxActiveOwnerTurns = 0

		const ownerTurnSignals: Array<() => void> = []

		const orch = new Orchestrator({
			store,
			worktreeProvider: wt,
			concurrency: 2, // Max 2 global owner processes
			sessionRunner: (bus) => {
				return new FakeSessionRunner(bus, {
					onPrompt: async (session, text) => {
						if (session.who.roleName === "work_item_owner") {
							activeOwnerTurns++
							maxActiveOwnerTurns = Math.max(
								maxActiveOwnerTurns,
								activeOwnerTurns,
							)

							// Hold the turn until released by the test
							await new Promise<void>((resolve) => {
								ownerTurnSignals.push(resolve)
							})

							activeOwnerTurns--

							// Simulate request_review
							const itemId = session.who.workItemId!
							bus.emit({
								type: "tool-call-ended",
								missionId: session.who.missionId,
								roleName: "work_item_owner",
								workItemId: itemId,
								toolCallId: `tc-${itemId}`,
								toolName: "request_review",
								result: { details: { summary: "done" } },
								isError: false,
							})
						} else if (session.who.roleName === "mission_lead") {
							if (text.includes("Define the mission")) {
								await store.writeMission({
									id: session.who.missionId,
									repoPath: "/test-repo",
									title: "M",
									description: "Desc",
									acceptanceCriteria: [],
									status: "in_progress",
								})
								await store.writePlan(session.who.missionId, {
									items: [
										{
											id: 1,
											title: "I1",
											description: "D",
											dependencies: [],
											status: "pending",
										},
										{
											id: 2,
											title: "I2",
											description: "D",
											dependencies: [],
											status: "pending",
										},
									],
								})
							} else if (text.includes("ready for review")) {
								const match = text.match(/Work item #(\d+)/)
								const itemId = match ? Number(match[1]) : 1

								// Accept
								await store.writeWorkItemStatus(
									session.who.missionId,
									itemId,
									"accepted",
								)
								bus.emit({
									type: "tool-call-ended",
									missionId: session.who.missionId,
									roleName: "mission_lead",
									toolCallId: `rw-${itemId}`,
									toolName: "review_work_item",
									result: {
										details: {
											decision: "accept",
											applied: true,
											workItemId: itemId,
										},
									},
									isError: false,
								})
							}
						}
					},
				})
			},
		})

		const p1 = orch.defineMission("Mission 1", { repoPath: "/repo1" })
		const p2 = orch.defineMission("Mission 2", { repoPath: "/repo2" })

		await new Promise((r) => setTimeout(r, 100))

		expect(activeOwnerTurns).toBe(2)
		expect(ownerTurnSignals.length).toBe(2)

		ownerTurnSignals.shift()!()
		await new Promise((r) => setTimeout(r, 100))

		expect(activeOwnerTurns).toBe(2)
		expect(ownerTurnSignals.length).toBe(2)

		ownerTurnSignals.shift()!()
		ownerTurnSignals.shift()!()
		await new Promise((r) => setTimeout(r, 100))

		const lastSignal = ownerTurnSignals.shift()
		if (lastSignal) lastSignal()

		await Promise.all([p1, p2])

		expect(maxActiveOwnerTurns).toBe(2)
	})

	test("resume all-at-once, bounded by the shared session semaphore", async () => {
		const store = new InMemoryStore()

		// Seed 2 non-terminal missions with ready items
		await store.writeMission({
			id: "m1",
			repoPath: "/r1",
			title: "m1",
			description: "m1",
			acceptanceCriteria: [],
			status: "in_progress",
		})
		await store.writePlan("m1", {
			items: [
				{
					id: 1,
					title: "1",
					description: "",
					dependencies: [],
					status: "in_progress",
				},
			],
		})

		await store.writeMission({
			id: "m2",
			repoPath: "/r2",
			title: "m2",
			description: "m2",
			acceptanceCriteria: [],
			status: "in_progress",
		})
		await store.writePlan("m2", {
			items: [
				{
					id: 1,
					title: "1",
					description: "",
					dependencies: [],
					status: "in_progress",
				},
			],
		})

		let activeOwnerTurns = 0
		let maxActiveOwnerTurns = 0
		const ownerTurnSignals: Array<() => void> = []

		const orch = new Orchestrator({
			store,
			worktreeProvider: new FakeWorktreeProvider(),
			concurrency: 1, // Only 1 allowed across all resumed missions
			sessionRunner: (bus) => {
				return new FakeSessionRunner(bus, {
					onPrompt: async (session) => {
						if (session.who.roleName === "work_item_owner") {
							activeOwnerTurns++
							maxActiveOwnerTurns = Math.max(
								maxActiveOwnerTurns,
								activeOwnerTurns,
							)
							await new Promise<void>((resolve) =>
								ownerTurnSignals.push(resolve),
							)
							activeOwnerTurns--
							const itemId = session.who.workItemId!
							bus.emit({
								type: "tool-call-ended",
								missionId: session.who.missionId,
								roleName: "work_item_owner",
								workItemId: itemId,
								toolCallId: `tc-${itemId}`,
								toolName: "request_review",
								result: { details: { summary: "done" } },
								isError: false,
							})
						} else {
							// lead accepts
							const itemId = 1
							await store.writeWorkItemStatus(
								session.who.missionId,
								itemId,
								"accepted",
							)
							bus.emit({
								type: "tool-call-ended",
								missionId: session.who.missionId,
								roleName: "mission_lead",
								toolCallId: `rw-${itemId}`,
								toolName: "review_work_item",
								result: {
									details: {
										decision: "accept",
										applied: true,
										workItemId: itemId,
									},
								},
								isError: false,
							})
						}
					},
				})
			},
		})

		// Resume both missions explicitly (no auto-resume), fire-and-forget as
		// start() used to: the drives run concurrently under the shared semaphore.
		void orch.resumeMission("m1").catch(() => {})
		void orch.resumeMission("m2").catch(() => {})

		// Event loop settles, items are queued.
		await new Promise((r) => setTimeout(r, 100))

		expect(activeOwnerTurns).toBe(1) // Only 1 active because of concurrency=1
		expect(ownerTurnSignals.length).toBe(1)

		// Release the first
		ownerTurnSignals.shift()!()
		await new Promise((r) => setTimeout(r, 100))

		// The second should start
		expect(activeOwnerTurns).toBe(1)
		expect(ownerTurnSignals.length).toBe(1)

		// Release the second
		ownerTurnSignals.shift()!()
		await new Promise((r) => setTimeout(r, 100))

		expect(maxActiveOwnerTurns).toBe(1)
	})
})
