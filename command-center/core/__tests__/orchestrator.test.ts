import { describe, expect, test } from "bun:test"
import type { DriverLock, LockAcquireResult } from "../driver-lock"
import type { Event, EventBus, EventListener } from "../events"
import { Orchestrator } from "../orchestrator"
import { FakeSessionRunner } from "../session"
import { InMemoryStore } from "../store"
import type { WorkItem } from "../types"
import { FakeWorktreeProvider } from "../worktree/provisioner"

// ---------------------------------------------------------------------------
// Orchestrator integration tests.
//
// FakeSessionRunner simulates the agents calling tools (via onPrompt hooks),
// FakeWorktreeProvider (no git), InMemoryStore. The tools write to the store
// and emit events onto a SHARED EventBus (the orchestrator's). The orchestrator
// reacts to the event stream captured during each prompt.
//
// Key wiring: the bus is created FIRST and shared by both the FakeSessionRunner
// and the Orchestrator (via reflection on the orch.bus field).
// ---------------------------------------------------------------------------

type PlanInput = {
	items: Array<Pick<WorkItem, "title" | "description" | "dependencies">>
}

interface FakeAgents {
	leadPlan?: PlanInput
	ownerSummary?: (itemId: number) => string
	leadDecision?: (itemId: number) => "accept" | "rework" | "cancel"
	leadFeedback?: string
	concurrency?: number
	driverLock?: DriverLock
}

/** Collect events into an array via a subscriber. */
function collect(orch: Orchestrator): Event[] {
	const events: Event[] = []
	const listener: EventListener = (e) => events.push(e)
	orch.subscribeAll(listener)
	return events
}

/** Find the latest event of a type in the collected stream. */
function lastEvent(events: Event[], type: Event["type"]): Event | undefined {
	for (let i = events.length - 1; i >= 0; i--) {
		const e = events[i]
		if (e && e.type === type) return e
	}
	return undefined
}

/**
 * Build an Orchestrator wired to fakes that share one EventBus.
 * The fake agents respond deterministically to prompts by calling tools.
 */
function makeOrch(agents: FakeAgents = {}): {
	orch: Orchestrator
	runner: FakeSessionRunner
	wt: FakeWorktreeProvider
	store: InMemoryStore
	bus: EventBus
} {
	const store = new InMemoryStore()
	const wt = new FakeWorktreeProvider()

	const leadPlan: PlanInput = agents.leadPlan ?? {
		items: [
			{ title: "Item A", description: "Do A", dependencies: [] },
			{ title: "Item B", description: "Do B", dependencies: [1] },
		],
	}
	const ownerSummary = agents.ownerSummary ?? ((id) => `Done item ${id}`)
	const leadDecision = agents.leadDecision ?? (() => "accept" as const)

	// Capture the runner the factory creates so tests can inspect its sessions.
	let runner!: FakeSessionRunner
	const orch = new Orchestrator({
		store,
		worktreeProvider: wt,
		sessionRunner: (orchBus) => {
			runner = new FakeSessionRunner(orchBus, {
				onPrompt: async (session, text) => {
					const missionId = session.who.missionId
					if (session.who.roleName === "mission_lead") {
						if (text.includes("Define the mission")) {
							await simulateDefineMission(store, orchBus, missionId, text)
							await simulateWritePlan(store, orchBus, missionId, leadPlan)
						} else if (text.includes("ready for review")) {
							const itemId = extractItemId(text)
							await simulateReviewWorkItem(
								store,
								orchBus,
								wt,
								missionId,
								itemId,
								leadDecision(itemId),
								agents.leadFeedback,
							)
						} else if (text.includes("rejected at the Acceptance gate")) {
							// Reject re-plan: add a new pending work item so the mission is no
							// longer all-terminal (avoids an immediate roll-up).
							await simulateAddItem(store, orchBus, missionId, {
								title: "Follow-up",
								description: "Address the rejection feedback",
								dependencies: [],
							})
						}
					} else if (session.who.roleName === "work_item_owner") {
						if (
							text.includes("has been assigned") ||
							text.includes("sent back for rework")
						) {
							const itemId = session.who.workItemId!
							await simulateRequestReview(
								orchBus,
								missionId,
								itemId,
								ownerSummary(itemId),
							)
						}
					}
				},
			})
			return runner
		},
		concurrency: agents.concurrency ?? 2,
		driverLock: agents.driverLock,
	})
	// The factory receives the orchestrator's own bus.
	const bus = (orch as unknown as { bus: EventBus }).bus

	return { orch, runner, wt, store, bus }
}

// --- Simulated tool calls (the real tools' effects, invoked directly) -------

async function simulateDefineMission(
	store: InMemoryStore,
	bus: EventBus,
	missionId: string,
	description: string,
) {
	await store.writeMission({
		id: missionId,
		repoPath: "/test-repo",
		title: "Test Mission",
		description,
		acceptanceCriteria: ["It works"],
		status: "in_progress",
	})
	bus.emit({
		type: "mission-defined",
		missionId,
		mission: (await store.readMission(missionId))!,
	})
}

async function simulateWritePlan(
	store: InMemoryStore,
	bus: EventBus,
	missionId: string,
	plan: PlanInput,
) {
	const items: WorkItem[] = plan.items.map((it, i) => ({
		id: i + 1,
		title: it.title,
		description: it.description,
		dependencies: it.dependencies,
		status: "pending",
	}))
	await store.writePlan(missionId, { items })
	const mission = await store.readMission(missionId)
	if (mission && mission.rejectionFeedback !== undefined) {
		await store.writeMission({ ...mission, rejectionFeedback: undefined })
	}
	bus.emit({ type: "plan-written", missionId, plan: { items } })
}

/** Append a single new pending item to the persisted plan (write_plan append). */
async function simulateAddItem(
	store: InMemoryStore,
	bus: EventBus,
	missionId: string,
	item: Pick<WorkItem, "title" | "description" | "dependencies">,
) {
	const plan = await store.readPlan(missionId)
	const items = plan ? [...plan.items] : []
	const nextId = items.reduce((max, i) => Math.max(max, i.id), 0) + 1
	items.push({
		id: nextId,
		title: item.title,
		description: item.description,
		dependencies: item.dependencies,
		status: "pending",
	})
	await store.writePlan(missionId, { items })
	const mission = await store.readMission(missionId)
	if (mission && mission.rejectionFeedback !== undefined) {
		await store.writeMission({ ...mission, rejectionFeedback: undefined })
	}
	bus.emit({ type: "plan-written", missionId, plan: { items } })
}

async function simulateRequestReview(
	bus: EventBus,
	missionId: string,
	itemId: number,
	summary: string,
) {
	bus.emit({
		type: "tool-call-ended",
		missionId,
		roleName: "work_item_owner",
		workItemId: itemId,
		toolCallId: `tc-rr-${itemId}`,
		toolName: "request_review",
		result: {
			details: { kind: "request_review", workItemId: itemId, summary },
		},
		isError: false,
	})
}

async function simulateReviewWorkItem(
	store: InMemoryStore,
	bus: EventBus,
	wt: FakeWorktreeProvider,
	missionId: string,
	itemId: number,
	decision: "accept" | "rework" | "cancel",
	feedback?: string,
) {
	const from =
		(await store.readPlan(missionId))?.items.find((i) => i.id === itemId)
			?.status ?? "ready_for_review"
	// On accept, the real review_work_item tool delegates the merge to
	// acceptAndMerge (wired to the WorktreeProvider). Simulate that path so the
	// worktree calls (acceptMerge) are recorded. On conflict, the tool would
	// throw and leave the item at ready_for_review — simulate that too.
	if (decision === "accept") {
		const title =
			(await store.readPlan(missionId))?.items.find((i) => i.id === itemId)
				?.title ?? `Item ${itemId}`
		const merge = await wt.acceptMerge("/test-repo", missionId, itemId, title)
		if (!merge.ok) {
			// Conflict: throw (the runtime marks isError); item stays ready_for_review.
			bus.emit({
				type: "tool-call-ended",
				missionId,
				roleName: "mission_lead",
				toolCallId: `tc-rw-${itemId}`,
				toolName: "review_work_item",
				result: {
					details: {
						kind: "review_work_item",
						workItemId: itemId,
						decision,
						applied: false,
						conflictingFiles: merge.conflictingFiles,
					},
				},
				isError: true,
			})
			return
		}
	}
	const to =
		decision === "accept"
			? "accepted"
			: decision === "cancel"
				? "cancelled"
				: "in_progress"
	if (from !== to) {
		await store.writeWorkItemStatus(missionId, itemId, to)
		bus.emit({
			type: "work-item-status-changed",
			missionId,
			workItemId: itemId,
			from,
			to,
			causedBy: { roleName: "mission_lead" },
		})
	}
	bus.emit({
		type: "tool-call-ended",
		missionId,
		roleName: "mission_lead",
		toolCallId: `tc-rw-${itemId}`,
		toolName: "review_work_item",
		result: {
			details: {
				kind: "review_work_item",
				workItemId: itemId,
				decision,
				applied: true,
				feedback,
			},
		},
		isError: false,
	})
}

function extractItemId(text: string): number {
	const m = text.match(/#(\d+)/)
	return m ? Number(m[1]) : 0
}

// ===========================================================================
// Tests
// ===========================================================================

describe("Orchestrator — defineMission", () => {
	test("generates a missionId, provisions integration worktree, drives the lead", async () => {
		const { orch, wt } = makeOrch({})
		const events = collect(orch)

		const missionId = await orch.defineMission("Build a hello world app", {
			repoPath: "/test-repo",
		})

		expect(missionId).toMatch(/^[0-9a-z]{8}$/)
		expect(wt.calls).toContain(`createIntegration:${missionId}`)
		expect(wt.calls).toContain("ensureGitignored")
		expect(lastEvent(events, "mission-defined")).toBeDefined()
		expect(lastEvent(events, "plan-written")).toBeDefined()
	})
})

describe("Orchestrator — provisioning failure leaves no orphan", () => {
	test("defineMission rejects and persists nothing when the worktree can't be provisioned", async () => {
		const store = new InMemoryStore()
		// Simulate an invalid repo / missing git: provisioning throws.
		const wt = new FakeWorktreeProvider()
		wt.createIntegrationWorktree = async () => {
			throw new Error("git branch failed (exit ENOENT)")
		}
		const orch = new Orchestrator({
			store,
			worktreeProvider: wt,
			sessionRunner: (orchBus) => new FakeSessionRunner(orchBus),
		})

		await expect(
			orch.defineMission("Create a thorough course", {
				repoPath: "/no-such-repo",
			}),
		).rejects.toThrow("exit ENOENT")

		// No orphaned stub survives the failure.
		expect(await orch.listMissions()).toEqual([])
	})
})

describe("Orchestrator — happy path (all items accepted)", () => {
	test("dispatches items in dependency order, accepts each, rolls up to ready_for_acceptance", async () => {
		const { orch, store, wt } = makeOrch({})
		const events = collect(orch)

		const missionId = await orch.defineMission("Test mission", {
			repoPath: "/test-repo",
		})

		const plan = await store.readPlan(missionId)
		expect(plan?.items.every((i) => i.status === "accepted")).toBe(true)

		const mission = await store.readMission(missionId)
		expect(mission?.status).toBe("ready_for_acceptance")

		expect(wt.calls).toContain(`createOwner:${missionId}:1`)
		expect(wt.calls).toContain(`createOwner:${missionId}:2`)
		expect(wt.calls).toContain(`removeOwner:${missionId}:1`)
		expect(wt.calls).toContain(`removeOwner:${missionId}:2`)

		const statusChanges = events.filter(
			(e) => e.type === "work-item-status-changed",
		)
		expect(statusChanges.length).toBeGreaterThanOrEqual(4)
		expect(lastEvent(events, "mission-status-changed")).toBeDefined()
	})
})

describe("Orchestrator — rework loop", () => {
	test("rework resumes the owner, who requests review again, then accepts", async () => {
		let reviewCount = 0
		const { orch, store, runner } = makeOrch({
			leadDecision: () => {
				reviewCount++
				return reviewCount === 1 ? "rework" : "accept"
			},
			leadFeedback: "Fix the tests",
		})

		const missionId = await orch.defineMission("Test mission", {
			repoPath: "/test-repo",
		})

		const plan = await store.readPlan(missionId)
		expect(plan?.items[0]?.status).toBe("accepted")
		// The owner was prompted at least twice (initial + rework).
		const owner = runner.sessions.get(`${missionId}:work_item_owner:1`)
		expect(owner?.prompts.length).toBeGreaterThanOrEqual(2)
	})
})

describe("Orchestrator — cancel", () => {
	test("cancel verdict → item cancelled, worktree torn down", async () => {
		const { orch, store, wt } = makeOrch({
			leadDecision: () => "cancel",
		})

		const missionId = await orch.defineMission("Test mission", {
			repoPath: "/test-repo",
		})

		const plan = await store.readPlan(missionId)
		// Item 1 cancelled; item 2 (depends on 1) can never be ready → stuck path.
		expect(plan?.items[0]?.status).toBe("cancelled")
		expect(wt.calls).toContain(`removeOwner:${missionId}:1`)
	})
})

describe("Orchestrator — reviewMission HITL", () => {
	test("accept → mission completed, integration worktree removed", async () => {
		const { orch, store, wt } = makeOrch({})
		const missionId = await orch.defineMission("Test mission", {
			repoPath: "/test-repo",
		})

		expect((await store.readMission(missionId))?.status).toBe(
			"ready_for_acceptance",
		)

		await orch.reviewMission(missionId, "accept")

		expect((await store.readMission(missionId))?.status).toBe("completed")
		expect(wt.calls).toContain(`removeIntegration:${missionId}`)
	})

	test("reject → mission back to in_progress, then re-drains to ready_for_acceptance (the gate can loop)", async () => {
		const { orch, store } = makeOrch({})
		const missionId = await orch.defineMission("Test mission", {
			repoPath: "/test-repo",
		})

		await orch.reviewMission(missionId, "reject", "Needs more polish")

		// Reject sets the mission to in_progress and the lead re-plans (adds a new
		// work item). That item gets dispatched + accepted, so the plan drains and
		// the mission returns to ready_for_acceptance — the human can reject again
		// (ticket 04 D7: the gate can loop).
		const mission = await store.readMission(missionId)
		expect(mission?.status).toBe("ready_for_acceptance")
		// And the plan now has the added follow-up item, accepted.
		const plan = await store.readPlan(missionId)
		expect(plan?.items.length).toBe(3)
		expect(plan?.items.every((i) => i.status === "accepted")).toBe(true)
	})
})

describe("Orchestrator — DAG dependencies", () => {
	test("item B (depends on A) dispatches only after A is accepted", async () => {
		const { orch, store, wt } = makeOrch({
			leadPlan: {
				items: [
					{ title: "A", description: "First", dependencies: [] },
					{ title: "B", description: "Second", dependencies: [1] },
				],
			},
		})

		const missionId = await orch.defineMission("DAG test", {
			repoPath: "/test-repo",
		})

		const plan = await store.readPlan(missionId)
		expect(plan?.items.every((i) => i.status === "accepted")).toBe(true)

		const createBIdx = wt.calls.indexOf(`createOwner:${missionId}:2`)
		const acceptAIdx = wt.calls.indexOf(`acceptMerge:${missionId}:1`)
		expect(createBIdx).toBeGreaterThanOrEqual(0)
		expect(acceptAIdx).toBeGreaterThanOrEqual(0)
		expect(createBIdx).toBeGreaterThan(acceptAIdx)
	})
})

describe("Orchestrator — concurrency", () => {
	test("two independent items dispatch and resolve", async () => {
		const { orch, store, wt } = makeOrch({
			leadPlan: {
				items: [
					{ title: "A", description: "Independent", dependencies: [] },
					{ title: "B", description: "Independent", dependencies: [] },
				],
			},
			concurrency: 2,
		})

		const missionId = await orch.defineMission("Concurrency test", {
			repoPath: "/test-repo",
		})

		const plan = await store.readPlan(missionId)
		expect(plan?.items.every((i) => i.status === "accepted")).toBe(true)
		expect(wt.calls).toContain(`createOwner:${missionId}:1`)
		expect(wt.calls).toContain(`createOwner:${missionId}:2`)
	})
})

describe("Orchestrator — deleteMission", () => {
	function makeBareOrch() {
		const store = new InMemoryStore()
		const wt = new FakeWorktreeProvider()
		const orch = new Orchestrator({
			store,
			worktreeProvider: wt,
			sessionRunner: (orchBus) => new FakeSessionRunner(orchBus),
		})
		return { orch, store, wt }
	}

	test("tears down worktrees+branches, clears state, emits mission-deleted", async () => {
		const { orch, store, wt } = makeBareOrch()
		const events = collect(orch)
		const missionId = "del12345"

		await store.writeMission({
			id: missionId,
			repoPath: "/test-repo",
			title: "Doomed",
			description: "d",
			acceptanceCriteria: [],
			status: "in_progress",
		})
		await store.writePlan(missionId, {
			items: [
				{
					id: 1,
					title: "A",
					description: "",
					dependencies: [],
					status: "accepted",
				},
				{
					id: 2,
					title: "B",
					description: "",
					dependencies: [1],
					status: "in_progress",
				},
			],
		})

		await orch.deleteMission(missionId)

		// Persisted state gone.
		expect(await store.readMission(missionId)).toBeNull()
		expect(await store.readPlan(missionId)).toBeNull()
		expect(await orch.listMissions()).toEqual([])

		// Owner teardown (checkout+branch) for every item, integration checkout, integration branch.
		expect(wt.calls).toContain(`removeOwner:${missionId}:1`)
		expect(wt.calls).toContain(`removeOwner:${missionId}:2`)
		expect(wt.calls).toContain(`removeIntegration:${missionId}`)
		expect(wt.calls).toContain(`removeIntegrationBranch:${missionId}`)

		expect(
			events.some(
				(e) => e.type === "mission-deleted" && e.missionId === missionId,
			),
		).toBe(true)
	})

	test("cleans persisted state even when the mission record is missing", async () => {
		const { orch, store, wt } = makeBareOrch()
		// No mission record (partially-corrupt case) but a persisted plan exists.
		await store.writePlan("orphan123", { items: [] })

		await orch.deleteMission("orphan123")

		expect(await store.readPlan("orphan123")).toBeNull()
		// No repoPath to act on ⇒ no worktree calls.
		expect(wt.calls).toEqual([])
	})
})

describe("Orchestrator — active session registration", () => {
	test("getActiveSession returns the lead session after defineMission", async () => {
		const { orch, runner } = makeOrch({})

		const missionId = await orch.defineMission("Test mission", {
			repoPath: "/test-repo",
		})

		const lead = orch.getActiveSession(missionId, "mission_lead")
		expect(lead).toBeDefined()
		// Matches the session the runner recorded for the lead role.
		expect(lead?.sessionId).toBe(
			runner.sessions.get(`${missionId}:mission_lead:_`)?.sessionId,
		)
	})

	test("owner session is registered while in-flight and deregistered on terminal accept", async () => {
		const store = new InMemoryStore()
		const wt = new FakeWorktreeProvider()

		let missionId!: string
		let ownerSeen!: (sessionId: string) => void
		const ownerSeenPromise = new Promise<string>((resolve) => {
			ownerSeen = resolve
		})
		let releaseOwner!: () => void
		const ownerBlocked = new Promise<void>((resolve) => {
			releaseOwner = resolve
		})

		const orch = new Orchestrator({
			store,
			worktreeProvider: wt,
			sessionRunner: (orchBus) =>
				new FakeSessionRunner(orchBus, {
					onPrompt: async (session, text) => {
						missionId = session.who.missionId
						if (session.who.roleName === "mission_lead") {
							if (text.includes("Define the mission")) {
								await simulateDefineMission(store, orchBus, missionId, text)
								await simulateWritePlan(store, orchBus, missionId, {
									items: [
										{ title: "Item A", description: "Do A", dependencies: [] },
									],
								})
							} else if (text.includes("ready for review")) {
								await simulateReviewWorkItem(
									store,
									orchBus,
									wt,
									missionId,
									1,
									"accept",
								)
							}
						} else if (session.who.roleName === "work_item_owner") {
							// Hold the owner's turn open so the session stays in-flight while
							// the test inspects it.
							ownerSeen(session.sessionId)
							await ownerBlocked
							const itemId = session.who.workItemId!
							await simulateRequestReview(
								orchBus,
								missionId,
								itemId,
								"Done item 1",
							)
						}
					},
				}),
		})

		const missionPromise = orch.defineMission("In-flight test", {
			repoPath: "/test-repo",
		})

		// The owner's turn is now blocked: the session must be registered.
		const ownerSessionId = await ownerSeenPromise
		expect(
			orch.getActiveSession(missionId, "work_item_owner", 1)?.sessionId,
		).toBe(ownerSessionId)

		// Let the owner finish → item accepted → session deregistered.
		releaseOwner()
		await missionPromise
		expect(
			orch.getActiveSession(missionId, "work_item_owner", 1),
		).toBeUndefined()
	})

	test("lead session stays registered while parked at ready_for_acceptance, then drops on accept", async () => {
		const { orch, store } = makeOrch({})

		const missionId = await orch.defineMission("Test mission", {
			repoPath: "/test-repo",
		})
		expect((await store.readMission(missionId))?.status).toBe(
			"ready_for_acceptance",
		)

		// Parked at the Acceptance gate — still attachable (the integration
		// worktree persists until the mission is terminal).
		expect(orch.getActiveSession(missionId, "mission_lead")).toBeDefined()

		await orch.reviewMission(missionId, "accept")

		// Integration worktree is gone → the lead session handle is dropped.
		expect(orch.getActiveSession(missionId, "mission_lead")).toBeUndefined()
	})
})

// ---------------------------------------------------------------------------
// Orchestrator — driver lock (multi-process coordination).
// ---------------------------------------------------------------------------

/** Records acquire/release calls; `stolen` simulates a foreign takeover. */
class RecordingLock implements DriverLock {
	acquireCalls: Array<{ force: boolean }> = []
	releaseCalls = 0
	stolen = false

	async acquire(
		_missionId: string,
		opts: { force?: boolean } = {},
	): Promise<LockAcquireResult> {
		this.acquireCalls.push({ force: opts.force ?? false })
		return { acquired: true }
	}

	async release() {
		this.releaseCalls++
	}

	async status() {
		return { held: !this.stolen, byMe: !this.stolen }
	}

	async isHeldByMe() {
		return !this.stolen
	}
}

describe("Orchestrator — driver lock (multi-process)", () => {
	test("resumeMission force-acquires the driver lock and releases it after the drive parks", async () => {
		const lock = new RecordingLock()
		const { orch, store } = makeOrch({ driverLock: lock })

		// Seed a mission with a plan so resume drives it (defineMission is not involved).
		await store.writeMission({
			id: "m1",
			repoPath: "/test-repo",
			title: "m1",
			description: "m1",
			acceptanceCriteria: [],
			status: "in_progress",
		})
		await store.writePlan("m1", {
			items: [
				{
					id: 1,
					title: "A",
					description: "Do A",
					dependencies: [],
					status: "pending",
				},
			],
		})

		const tookOver = await orch.resumeMission("m1")

		expect(tookOver).toBeUndefined()
		expect(lock.acquireCalls).toEqual([{ force: true }])
		expect(lock.releaseCalls).toBe(1)
		expect((await store.readPlan("m1"))?.items[0]?.status).toBe("accepted")
	})

	test("defineMission acquires the driver lock without force and releases after the drive parks", async () => {
		const lock = new RecordingLock()
		const { orch } = makeOrch({ driverLock: lock })

		const missionId = await orch.defineMission("Test mission", {
			repoPath: "/test-repo",
		})

		expect(missionId).toMatch(/^[0-9a-z]{8}$/)
		expect(lock.acquireCalls).toEqual([{ force: false }])
		expect(lock.releaseCalls).toBe(1)
	})

	test("a drive stops immediately when the lock is not held when the loop starts", async () => {
		const lock = new RecordingLock()
		lock.stolen = true // another process holds it (or took it mid-run)
		const { orch, store } = makeOrch({ driverLock: lock })

		await store.writeMission({
			id: "m1",
			repoPath: "/test-repo",
			title: "m1",
			description: "m1",
			acceptanceCriteria: [],
			status: "in_progress",
		})
		await store.writePlan("m1", {
			items: [
				{
					id: 1,
					title: "A",
					description: "Do A",
					dependencies: [],
					status: "pending",
				},
			],
		})

		await orch.resumeMission("m1")

		// Nothing was dispatched; the loop parked on the displacement guard.
		expect((await store.readPlan("m1"))?.items[0]?.status).toBe("pending")
		expect(lock.releaseCalls).toBe(1)
	})

	test("a displaced driver stops mid-run when another process steals the lock", async () => {
		const store = new InMemoryStore()
		const wt = new FakeWorktreeProvider()
		const lock = new RecordingLock()

		await store.writeMission({
			id: "m1",
			repoPath: "/test-repo",
			title: "m1",
			description: "m1",
			acceptanceCriteria: [],
			status: "in_progress",
		})
		await store.writePlan("m1", {
			items: [
				{
					id: 1,
					title: "A",
					description: "Do A",
					dependencies: [],
					status: "pending",
				},
			],
		})

		let ownerStarted!: () => void
		let releaseOwner!: () => void
		const ownerStartedP = new Promise<void>((r) => {
			ownerStarted = r
		})
		const ownerBlockedP = new Promise<void>((r) => {
			releaseOwner = r
		})

		const orch = new Orchestrator({
			store,
			worktreeProvider: wt,
			driverLock: lock,
			sessionRunner: (bus) =>
				new FakeSessionRunner(bus, {
					onPrompt: async (session) => {
						if (session.who.roleName === "work_item_owner") {
							ownerStarted()
							await ownerBlockedP
							bus.emit({
								type: "tool-call-ended",
								missionId: session.who.missionId,
								roleName: "work_item_owner",
								workItemId: session.who.workItemId,
								toolCallId: "tc-1",
								toolName: "request_review",
								result: { details: { summary: "done" } },
								isError: false,
							})
						} else {
							// Lead reviews: accept item 1 (write the accepted status,
							// as the real review_work_item tool does).
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
								toolCallId: "rw-1",
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
				}),
		})

		const drive = orch.resumeMission("m1")
		await ownerStartedP // the owner's turn is in flight
		lock.stolen = true // another process takes over the drive mid-run
		releaseOwner()

		await drive

		// The in-flight item finished, but the drive stopped BEFORE the roll-up:
		// the mission stays in_progress instead of reaching ready_for_acceptance.
		expect((await store.readPlan("m1"))?.items[0]?.status).toBe("accepted")
		expect((await store.readMission("m1"))?.status).toBe("in_progress")
		expect(lock.releaseCalls).toBe(1)
	})

	// ---------------------------------------------------------------------
	// registerMission (read-only repo registration, e.g. /cc attach)
	// ---------------------------------------------------------------------

	test("registerMission loads a persisted mission's repo so cwdFor resolves without a drive", async () => {
		const { orch, store } = makeOrch()
		const missionId = "attach-target"

		// A mission persisted in the store but never driven by this process.
		await store.writeMission({
			id: missionId,
			repoPath: "/test-repo",
			title: "Test Mission",
			description: "desc",
			acceptanceCriteria: ["It works"],
			status: "in_progress",
		})

		// Before registration, cwd resolution fails (the in-memory repo map is
		// empty on a fresh process).
		expect(() => orch.cwdFor({ missionId, roleName: "mission_lead" })).toThrow(
			/No repo registered/,
		)

		await orch.registerMission(missionId)
		expect(orch.cwdFor({ missionId, roleName: "mission_lead" })).toBe(
			"/fake-repo/.command-center/worktrees/attach-target/integration",
		)

		// Idempotent: a second registration is a no-op.
		await orch.registerMission(missionId)
		expect(orch.cwdFor({ missionId, roleName: "mission_lead" })).toBe(
			"/fake-repo/.command-center/worktrees/attach-target/integration",
		)
	})

	test("registerMission throws for a mission missing from the store", async () => {
		const { orch } = makeOrch()
		expect(orch.registerMission("ghost-mission")).rejects.toThrow(
			/Unknown mission: ghost-mission/,
		)
	})
})
