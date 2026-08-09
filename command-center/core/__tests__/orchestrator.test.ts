import { describe, expect, test } from "bun:test"
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent"
import type { DriverLock, LockAcquireResult } from "../driver-lock"
import type { Event, EventBus, EventListener } from "../events"
import { Orchestrator } from "../orchestrator"
import { FakeSessionRunner, PiVisibleLeadSessionRunner } from "../session"
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
	ownerHelpReason?: string
	leadGuidance?: string
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
	const helpedOwners = new Set<string>()

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
						if (text.includes("requested help")) {
							const itemId = extractItemId(text)
							await simulateRespondToHelp(
								orchBus,
								missionId,
								itemId,
								agents.leadGuidance ?? "Try the smaller change first.",
							)
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
						} else if (text.includes("Define the mission")) {
							await simulateDefineMission(store, orchBus, missionId, text)
							await simulateWritePlan(store, orchBus, missionId, leadPlan)
						}
					} else if (session.who.roleName === "work_item_owner") {
						if (
							text.includes("has been assigned") ||
							text.includes("sent back for rework") ||
							text.includes("Review handoff for work item") ||
							text.includes("Mission Lead has responded")
						) {
							const itemId = session.who.workItemId!
							const helpKey = `${missionId}:${itemId}`
							if (
								agents.ownerHelpReason &&
								text.includes("has been assigned") &&
								!helpedOwners.has(helpKey)
							) {
								helpedOwners.add(helpKey)
								await simulateRequestHelp(
									orchBus,
									missionId,
									itemId,
									agents.ownerHelpReason,
								)
							} else {
								await simulateRequestReview(
									orchBus,
									missionId,
									itemId,
									ownerSummary(itemId),
								)
							}
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

async function simulateRequestHelp(
	bus: EventBus,
	missionId: string,
	itemId: number,
	reason: string,
) {
	bus.emit({
		type: "tool-call-ended",
		missionId,
		roleName: "work_item_owner",
		workItemId: itemId,
		toolCallId: `tc-rh-${itemId}`,
		toolName: "request_help",
		result: {
			details: { kind: "request_help", workItemId: itemId, reason },
		},
		isError: false,
	})
}

async function simulateRespondToHelp(
	bus: EventBus,
	missionId: string,
	itemId: number,
	guidance: string,
) {
	bus.emit({
		type: "tool-call-ended",
		missionId,
		roleName: "mission_lead",
		toolCallId: `tc-rth-${itemId}`,
		toolName: "respond_to_help",
		result: {
			details: { kind: "respond_to_help", workItemId: itemId, guidance },
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

type VisiblePiApi = Pick<
	ExtensionAPI,
	| "on"
	| "sendUserMessage"
	| "registerTool"
	| "getActiveTools"
	| "setActiveTools"
>

class ScriptedVisiblePi {
	readonly handlers = new Map<
		string,
		Array<(event: unknown, ctx: ExtensionContext) => unknown>
	>()
	readonly registeredTools: ToolDefinition[] = []
	readonly sent: string[] = []
	activeTools: string[] = []
	onSend?: (text: string, ctx: ExtensionContext) => Promise<void>
	private toolCounter = 0

	constructor(private readonly ctx: ExtensionContext) {}

	on(
		event: string,
		handler: (event: unknown, ctx: ExtensionContext) => unknown,
	): void {
		const list = this.handlers.get(event) ?? []
		list.push(handler)
		this.handlers.set(event, list)
	}

	registerTool(tool: ToolDefinition): void {
		this.registeredTools.push(tool)
		if (!this.activeTools.includes(tool.name)) this.activeTools.push(tool.name)
	}

	getActiveTools(): string[] {
		return [...this.activeTools]
	}

	setActiveTools(toolNames: string[]): void {
		this.activeTools = [...toolNames]
	}

	sendUserMessage(text: string): void {
		this.sent.push(text)
		queueMicrotask(() => {
			this.onSend?.(text, this.ctx).catch((error) => {
				throw error
			})
		})
	}

	async emit(
		eventName: string,
		event: unknown,
		ctx: ExtensionContext = this.ctx,
	): Promise<void> {
		for (const handler of this.handlers.get(eventName) ?? []) {
			await handler(event, ctx)
		}
	}

	async executeTool(
		name: string,
		params: unknown,
		ctx: ExtensionContext = this.ctx,
	): Promise<void> {
		const tool = this.registeredTools.find((t) => t.name === name)
		if (!tool) throw new Error(`visible tool not registered: ${name}`)
		const toolCallId = `visible-${++this.toolCounter}`
		await this.emit(
			"tool_execution_start",
			{
				type: "tool_execution_start",
				toolCallId,
				toolName: name,
				args: params,
			},
			ctx,
		)
		let result: unknown
		let isError = false
		try {
			result = await (tool.execute as (...args: unknown[]) => Promise<unknown>)(
				toolCallId,
				params,
				new AbortController().signal,
				undefined,
				ctx,
			)
		} catch (error) {
			isError = true
			result = {
				content: [
					{
						type: "text",
						text: error instanceof Error ? error.message : String(error),
					},
				],
			}
		}
		await this.emit(
			"tool_execution_end",
			{
				type: "tool_execution_end",
				toolCallId,
				toolName: name,
				result,
				isError,
			},
			ctx,
		)
	}

	async settle(ctx: ExtensionContext = this.ctx): Promise<void> {
		await this.emit("agent_settled", { type: "agent_settled" }, ctx)
	}
}

function visibleContext(sessionId = "visible-lead-session"): ExtensionContext {
	return {
		cwd: "/fake-repo/.command-center/worktrees/visible1/integration",
		isIdle: () => true,
		abort: () => undefined,
		sessionManager: { getSessionId: () => sessionId },
	} as ExtensionContext
}

async function waitFor(
	cond: () => Promise<boolean>,
	timeoutMs = 2000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (await cond()) return
		await new Promise((r) => setTimeout(r, 10))
	}
	throw new Error("timed out waiting for the background drive")
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

describe("Orchestrator — createMission (interactive definition)", () => {
	test("creates a pending stub + worktree + lead session with a framing prompt, and drives nothing", async () => {
		const { orch, runner, wt, store } = makeOrch({})
		const events = collect(orch)

		const missionId = await orch.createMission({ repoPath: "/test-repo" })

		expect(missionId).toMatch(/^[0-9a-z]{8}$/)
		// Pending stub: the mission is NOT launched and nothing is driven.
		expect((await store.readMission(missionId))?.status).toBe("pending")
		expect(wt.calls).toContain(`createIntegration:${missionId}`)
		expect(wt.calls.filter((c) => c.startsWith("createOwner:"))).toEqual([])

		// The lead session was acquired and got the interactive framing prompt.
		const lead = runner.sessions.get(`${missionId}:mission_lead:_`)
		expect(lead).toBeDefined()
		expect(lead!.prompts).toHaveLength(1)
		expect(lead!.prompts[0]).toContain("Mission Lead for Mission")
		// No mission-defined / plan-written — the lead only opened the dialogue.
		expect(lastEvent(events, "mission-defined")).toBeUndefined()
		expect(lastEvent(events, "plan-written")).toBeUndefined()
	})
})

describe("Orchestrator — bindVisibleLead (interactive definition after /cc new)", () => {
	/**
	 * A visible-lead runner whose "attachment" is dynamic: /cc new acquires
	 * the lead while the visible session is still in the source repo (hidden
	 * fallback), the extension switches the UI into the integration worktree,
	 * and only then re-binds the lead to the visible session.
	 */
	function makeVisibleOrch(
		attached: () => boolean,
		missionIdRef: { current: string },
	): {
		orch: Orchestrator
		pi: ScriptedVisiblePi
		ctx: ExtensionContext
		hidden: FakeSessionRunner
		store: InMemoryStore
	} {
		const store = new InMemoryStore()
		const ctx = visibleContext()
		const pi = new ScriptedVisiblePi(ctx)
		let hidden!: FakeSessionRunner
		const orch = new Orchestrator({
			store,
			worktreeProvider: new FakeWorktreeProvider(),
			sessionRunner: (bus, store) => {
				hidden = new FakeSessionRunner(bus)
				return new PiVisibleLeadSessionRunner({
					bus,
					store,
					pi: pi as unknown as VisiblePiApi,
					getContext: () => ctx,
					resolveVisibleRole: () =>
						attached()
							? { missionId: missionIdRef.current, roleName: "mission_lead" }
							: undefined,
					hiddenRunner: hidden,
				})
			},
		})
		return { orch, pi, ctx, hidden, store }
	}

	test("re-binds the pending lead to the visible session after the switch, registering its domain tools", async () => {
		let attached = false
		const missionIdRef = { current: "" }
		const { orch, pi, hidden } = makeVisibleOrch(() => attached, missionIdRef)

		// /cc new: the visible session is still in the source repo, so the lead
		// is acquired through the HIDDEN runner (its only job: flush a thread
		// file to switch to). No domain tools reach the visible pi.
		const missionId = await orch.createMission({ repoPath: "/test-repo" })
		missionIdRef.current = missionId
		expect(hidden.sessions.get(`${missionId}:mission_lead:_`)).toBeDefined()
		expect(pi.registeredTools).toEqual([])
		expect(pi.sent).toEqual([])

		// The extension switched the UI into the integration-worktree thread.
		attached = true
		await orch.bindVisibleLead(missionId)

		// The lead is now bound to the visible session: its domain tools are
		// registered + activated on the visible pi and the active session
		// handle points at the visible session.
		const names = pi.registeredTools.map((t) => t.name)
		expect(names).toContain("define_mission")
		expect(names).toContain("write_plan")
		expect(names).toContain("review_work_item")
		expect(pi.activeTools).toContain("define_mission")
		expect(pi.activeTools).toContain("write_plan")
		expect(orch.getActiveSession(missionId, "mission_lead")?.sessionId).toBe(
			"visible-lead-session",
		)
		// The framing prompt went to the hidden flush session, not the visible pi.
		expect(pi.sent).toEqual([])
	})

	test("no-ops when the mission is not pending (driven missions bind on their own)", async () => {
		const missionIdRef = { current: "visible1" }
		const { orch, pi, hidden, store } = makeVisibleOrch(
			() => true,
			missionIdRef,
		)
		await store.writeMission({
			id: "visible1",
			repoPath: "/test-repo",
			title: "visible1",
			description: "visible1",
			acceptanceCriteria: [],
			status: "in_progress",
		})
		await orch.registerMission("visible1")

		await orch.bindVisibleLead("visible1")

		expect(pi.registeredTools).toEqual([])
		expect(hidden.sessions.size).toBe(0)
	})

	test("binds from a fresh module instance without prior registration (session_start auto-bind path)", async () => {
		// After /cc new, pi re-loads the extension for the worktree cwd, so the
		// bind runs on a FRESH Orchestrator that has never seen the mission
		// (empty repo map). bindVisibleLead must register the mission from the
		// Store itself — this is the exact call the extension's session_start
		// handler makes when the UI lands in a pending lead worktree.
		const missionIdRef = { current: "visible2" }
		const { orch, pi, hidden, store } = makeVisibleOrch(
			() => true,
			missionIdRef,
		)
		await store.writeMission({
			id: "visible2",
			repoPath: "/test-repo",
			title: "visible2",
			description: "visible2",
			acceptanceCriteria: [],
			status: "pending",
		})
		// NOTE: deliberately NO orch.registerMission("visible2") first.

		await orch.bindVisibleLead("visible2")

		const names = pi.registeredTools.map((t) => t.name)
		expect(names).toContain("define_mission")
		expect(names).toContain("write_plan")
		expect(pi.activeTools).toContain("define_mission")
		expect(orch.getActiveSession("visible2", "mission_lead")?.sessionId).toBe(
			"visible-lead-session",
		)
		expect(hidden.sessions.size).toBe(0)
	})

	test("falls back to the hidden runner when the visible session is not attached", async () => {
		const missionIdRef = { current: "visible1" }
		const { orch, pi, hidden, store } = makeVisibleOrch(
			() => false,
			missionIdRef,
		)
		await store.writeMission({
			id: "visible1",
			repoPath: "/test-repo",
			title: "visible1",
			description: "visible1",
			acceptanceCriteria: [],
			status: "pending",
		})
		await orch.registerMission("visible1")

		await orch.bindVisibleLead("visible1")

		expect(pi.registeredTools).toEqual([])
		expect(hidden.sessions.get("visible1:mission_lead:_")).toBeDefined()
	})
})

describe("Orchestrator — launchMission", () => {
	/** Poll the store until `cond` holds (the drive is fire-and-forget). */
	async function waitFor(
		cond: () => Promise<boolean>,
		timeoutMs = 2000,
	): Promise<void> {
		const deadline = Date.now() + timeoutMs
		while (Date.now() < deadline) {
			if (await cond()) return
			await new Promise((r) => setTimeout(r, 10))
		}
		throw new Error("timed out waiting for the background drive")
	}

	test("launches a pending mission (pending → in_progress) and drives its plan in the background", async () => {
		const { orch, store, bus, wt } = makeOrch({})
		const missionId = await orch.createMission({ repoPath: "/test-repo" })

		// Simulate the interactive planning phase: the lead writes the plan.
		await simulateWritePlan(store, bus, missionId, {
			items: [{ title: "Item A", description: "Do A", dependencies: [] }],
		})

		await orch.launchMission(missionId)

		// The transition is synchronous; the drive runs in the background.
		expect((await store.readMission(missionId))?.status).toBe("in_progress")
		await waitFor(
			async () =>
				(await store.readMission(missionId))?.status === "ready_for_acceptance",
		)
		expect((await store.readPlan(missionId))?.items[0]?.status).toBe("accepted")
		expect(wt.calls).toContain(`createOwner:${missionId}:1`)
	})

	test("refuses to launch an already-launched (in_progress) mission", async () => {
		const { orch, store } = makeOrch({})
		await store.writeMission({
			id: "m1",
			repoPath: "/test-repo",
			title: "m1",
			description: "m1",
			acceptanceCriteria: [],
			status: "in_progress",
		})
		await expect(orch.launchMission("m1")).rejects.toThrow(/not pending/)
	})

	test("refuses to launch a mission with no plan yet", async () => {
		const { orch } = makeOrch({})
		const missionId = await orch.createMission({ repoPath: "/test-repo" })
		await expect(orch.launchMission(missionId)).rejects.toThrow(
			/has no plan yet/,
		)
	})

	test("refuses to launch an unknown mission", async () => {
		const { orch } = makeOrch({})
		await expect(orch.launchMission("ghost")).rejects.toThrow(
			/Unknown mission: ghost/,
		)
	})
})

describe("Orchestrator — visible lead event bridge", () => {
	test("review_work_item results from the visible lead reach the review loop once", async () => {
		const store = new InMemoryStore()
		const wt = new FakeWorktreeProvider()
		const ctx = visibleContext()
		const pi = new ScriptedVisiblePi(ctx)
		const missionId = "visible1"
		const busEvents: Event[] = []

		const orch = new Orchestrator({
			store,
			worktreeProvider: wt,
			sessionRunner: (bus, store) => {
				bus.subscribe((e) => busEvents.push(e))
				return new PiVisibleLeadSessionRunner({
					bus,
					store,
					pi: pi as unknown as VisiblePiApi,
					getContext: () => ctx,
					resolveVisibleRole: () => ({
						missionId,
						roleName: "mission_lead",
					}),
					hiddenRunner: new FakeSessionRunner(bus, {
						onPrompt: async (session) => {
							if (session.who.roleName !== "work_item_owner") return
							await simulateRequestReview(
								bus,
								missionId,
								session.who.workItemId!,
								"visible review ready",
							)
						},
					}),
				})
			},
		})

		await store.writeMission({
			id: missionId,
			repoPath: "/test-repo",
			title: "Visible Review",
			description: "exercise visible review",
			acceptanceCriteria: [],
			status: "pending",
		})
		await store.writePlan(missionId, {
			items: [
				{
					id: 1,
					title: "Item A",
					description: "Do A",
					dependencies: [],
					status: "pending",
				},
			],
		})
		await orch.registerMission(missionId)

		pi.onSend = async (text, toolCtx) => {
			if (text.includes("ready for review")) {
				await pi.executeTool(
					"review_work_item",
					{ workItemId: 1, decision: "accept" },
					toolCtx,
				)
			}
			await pi.settle(toolCtx)
		}

		await orch.launchMission(missionId)
		await waitFor(
			async () =>
				(await store.readMission(missionId))?.status === "ready_for_acceptance",
		)

		expect((await store.readPlan(missionId))?.items[0]?.status).toBe("accepted")
		expect(
			busEvents.filter(
				(e) =>
					e.type === "tool-call-ended" && e.toolName === "review_work_item",
			),
		).toHaveLength(1)
		expect(wt.calls).toContain(`acceptMerge:${missionId}:1`)
	})

	test("review rework then accept flows through the visible lead path", async () => {
		const store = new InMemoryStore()
		const wt = new FakeWorktreeProvider()
		const ctx = visibleContext()
		const pi = new ScriptedVisiblePi(ctx)
		const missionId = "visible1"
		const busEvents: Event[] = []
		let reviewTurn = 0

		const orch = new Orchestrator({
			store,
			worktreeProvider: wt,
			sessionRunner: (bus, store) => {
				bus.subscribe((e) => busEvents.push(e))
				return new PiVisibleLeadSessionRunner({
					bus,
					store,
					pi: pi as unknown as VisiblePiApi,
					getContext: () => ctx,
					resolveVisibleRole: () => ({
						missionId,
						roleName: "mission_lead",
					}),
					hiddenRunner: new FakeSessionRunner(bus, {
						onPrompt: async (session, text) => {
							if (session.who.roleName !== "work_item_owner") return
							if (text.includes("sent back for rework")) {
								expect(text).toContain("Add regression coverage")
							}
							await simulateRequestReview(
								bus,
								missionId,
								session.who.workItemId!,
								text.includes("sent back for rework")
									? "fixed after visible rework"
									: "visible review ready",
							)
						},
					}),
				})
			},
		})

		await store.writeMission({
			id: missionId,
			repoPath: "/test-repo",
			title: "Visible Rework",
			description: "exercise visible rework",
			acceptanceCriteria: [],
			status: "pending",
		})
		await store.writePlan(missionId, {
			items: [
				{
					id: 1,
					title: "Item A",
					description: "Do A",
					dependencies: [],
					status: "pending",
				},
			],
		})
		await orch.registerMission(missionId)

		pi.onSend = async (text, toolCtx) => {
			if (text.includes("ready for review")) {
				reviewTurn++
				await pi.executeTool(
					"review_work_item",
					reviewTurn === 1
						? {
								workItemId: 1,
								decision: "rework",
								feedback: "Add regression coverage",
							}
						: { workItemId: 1, decision: "accept" },
					toolCtx,
				)
			}
			await pi.settle(toolCtx)
		}

		await orch.launchMission(missionId)
		await waitFor(
			async () =>
				(await store.readMission(missionId))?.status === "ready_for_acceptance",
		)

		expect(reviewTurn).toBe(2)
		expect((await store.readPlan(missionId))?.items[0]?.status).toBe("accepted")
		expect(
			busEvents.filter(
				(e) =>
					e.type === "tool-call-ended" && e.toolName === "review_work_item",
			),
		).toHaveLength(2)
		expect(
			busEvents.some(
				(e) =>
					e.type === "work-item-status-changed" &&
					e.workItemId === 1 &&
					e.to === "in_progress",
			),
		).toBe(true)
		expect(wt.calls).toContain(`acceptMerge:${missionId}:1`)
	})

	test("respond_to_help details from the visible lead reach triage before owner continuation", async () => {
		const store = new InMemoryStore()
		const wt = new FakeWorktreeProvider()
		const ctx = visibleContext()
		const pi = new ScriptedVisiblePi(ctx)
		const missionId = "visible1"
		const busEvents: Event[] = []

		const orch = new Orchestrator({
			store,
			worktreeProvider: wt,
			sessionRunner: (bus, store) => {
				bus.subscribe((e) => busEvents.push(e))
				return new PiVisibleLeadSessionRunner({
					bus,
					store,
					pi: pi as unknown as VisiblePiApi,
					getContext: () => ctx,
					resolveVisibleRole: () => ({
						missionId,
						roleName: "mission_lead",
					}),
					hiddenRunner: new FakeSessionRunner(bus, {
						onPrompt: async (session, text) => {
							if (session.who.roleName !== "work_item_owner") return
							const itemId = session.who.workItemId!
							if (text.includes("has been assigned")) {
								bus.emit({
									type: "tool-call-ended",
									missionId,
									roleName: "work_item_owner",
									workItemId: itemId,
									toolCallId: "tc-help",
									toolName: "request_help",
									result: {
										details: {
											kind: "request_help",
											workItemId: itemId,
											reason: "blocked on visible triage",
										},
									},
									isError: false,
								})
							} else if (text.includes("Mission Lead has responded")) {
								expect(text).toContain("Use the existing helper")
								await simulateRequestReview(
									bus,
									missionId,
									itemId,
									"continued after visible help",
								)
							}
						},
					}),
				})
			},
		})

		await store.writeMission({
			id: missionId,
			repoPath: "/test-repo",
			title: "Visible Triage",
			description: "exercise visible triage",
			acceptanceCriteria: [],
			status: "pending",
		})
		await store.writePlan(missionId, {
			items: [
				{
					id: 1,
					title: "Item A",
					description: "Do A",
					dependencies: [],
					status: "pending",
				},
			],
		})
		await orch.registerMission(missionId)

		pi.onSend = async (text, toolCtx) => {
			if (text.includes("requested help")) {
				await pi.executeTool(
					"write_plan",
					{
						items: [
							{
								id: 1,
								title: "Item A",
								description: "Do A",
								dependencies: [],
							},
						],
					},
					toolCtx,
				)
				await pi.executeTool(
					"respond_to_help",
					{ workItemId: 1, guidance: "Use the existing helper" },
					toolCtx,
				)
			} else if (text.includes("ready for review")) {
				await pi.executeTool(
					"review_work_item",
					{ workItemId: 1, decision: "accept" },
					toolCtx,
				)
			}
			await pi.settle(toolCtx)
		}

		await orch.launchMission(missionId)
		await waitFor(
			async () =>
				(await store.readMission(missionId))?.status === "ready_for_acceptance",
		)

		expect(
			busEvents.some(
				(e) =>
					e.type === "help-responded" &&
					e.workItemId === 1 &&
					e.guidance === "Use the existing helper",
			),
		).toBe(true)
		expect(
			busEvents.filter(
				(e) => e.type === "tool-call-ended" && e.toolName === "respond_to_help",
			),
		).toHaveLength(1)
		expect(
			busEvents.some(
				(e) => e.type === "plan-written" && e.missionId === missionId,
			),
		).toBe(true)
		expect((await store.readPlan(missionId))?.items[0]?.status).toBe("accepted")
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
		const { orch, store, wt, runner } = makeOrch({})
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

		const lead = runner.sessions.get(`${missionId}:mission_lead:_`)
		const reviewPrompt = lead?.prompts.find((p) =>
			p.includes("ready for review"),
		)
		expect(reviewPrompt).toContain("[Command Center]")
		expect(reviewPrompt).toContain("System notice")
		expect(reviewPrompt).toContain("- Work item: #1")
		expect(reviewPrompt).toContain("- Description: Do A")
		expect(reviewPrompt).toContain("- Dependencies: none")
		expect(reviewPrompt).toContain(`- Owner's branch: cc/${missionId}/work/1`)
		expect(reviewPrompt).toContain("Owner's summary:")
		expect(reviewPrompt).toContain("review_work_item({ workItemId: 1")

		const statusChanges = events.filter(
			(e) => e.type === "work-item-status-changed",
		)
		expect(statusChanges.length).toBeGreaterThanOrEqual(4)
		expect(lastEvent(events, "mission-status-changed")).toBeDefined()
	})
})

describe("Orchestrator — lead prompt framing", () => {
	test("frames owner help requests as visible Command Center lead injections", async () => {
		const { orch, store, runner } = makeOrch({
			leadPlan: {
				items: [
					{
						title: "Need API guidance",
						description: "Choose the safest integration API",
						dependencies: [],
					},
				],
			},
			ownerHelpReason: "I cannot tell which API is stable.",
			leadGuidance: "Use the documented stable API.",
		})

		const missionId = await orch.defineMission("Test mission", {
			repoPath: "/test-repo",
		})

		expect((await store.readMission(missionId))?.status).toBe(
			"ready_for_acceptance",
		)
		const lead = runner.sessions.get(`${missionId}:mission_lead:_`)
		const helpPrompt = lead?.prompts.find((p) => p.includes("requested help"))
		expect(helpPrompt).toContain("[Command Center]")
		expect(helpPrompt).toContain("System notice")
		expect(helpPrompt).toContain("- Work item: #1")
		expect(helpPrompt).toContain(
			"- Description: Choose the safest integration API",
		)
		expect(helpPrompt).toContain("- Dependencies: none")
		expect(helpPrompt).toContain(`- Owner's branch: cc/${missionId}/work/1`)
		expect(helpPrompt).toContain("Owner's reason:")
		expect(helpPrompt).toContain("I cannot tell which API is stable.")
		expect(helpPrompt).toContain("respond_to_help({ workItemId: 1")
	})
})

describe("Orchestrator — review handoff gate", () => {
	test("reprompts the owner when the branch is not review-ready", async () => {
		const { orch, wt, store, runner } = makeOrch({
			leadPlan: {
				items: [{ title: "Item A", description: "Do A", dependencies: [] }],
			},
		})
		wt.reviewReadinessResults = [
			{
				ready: false,
				reason:
					"The owner worktree is dirty; commit and clean it before review.",
			},
			{ ready: true },
		]

		const missionId = await orch.defineMission("Test mission", {
			repoPath: "/test-repo",
		})

		const plan = await store.readPlan(missionId)
		expect(plan?.items[0]?.status).toBe("accepted")
		expect(
			wt.calls.filter((call) => call.startsWith("reviewReadiness:")).length,
		).toBe(2)
		expect(wt.calls).toContain(`acceptMerge:${missionId}:1`)
		const owner = runner.sessions.get(`${missionId}:work_item_owner:1`)
		expect(owner?.prompts.some((p) => p.includes("not ready"))).toBe(true)
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
		const { orch, store, wt, runner } = makeOrch({
			leadDecision: () => "cancel",
		})

		const missionId = await orch.defineMission("Test mission", {
			repoPath: "/test-repo",
		})

		const plan = await store.readPlan(missionId)
		// Item 1 cancelled; item 2 (depends on 1) can never be ready → stuck path.
		expect(plan?.items[0]?.status).toBe("cancelled")
		expect(wt.calls).toContain(`removeOwner:${missionId}:1`)

		const lead = runner.sessions.get(`${missionId}:mission_lead:_`)
		const stuckPrompt = lead?.prompts.find((p) =>
			p.includes("The plan cannot progress"),
		)
		expect(stuckPrompt).toContain("[Command Center]")
		expect(stuckPrompt).toContain("Plan cannot progress")
		expect(stuckPrompt).toContain('#2 ("Item B")')
		expect(stuckPrompt).toContain("Description: Do B")
		expect(stuckPrompt).toContain("Cancelled items: #1")
		expect(stuckPrompt).toContain("Call write_plan")
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
		const { orch, store, runner } = makeOrch({})
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

		const lead = runner.sessions.get(`${missionId}:mission_lead:_`)
		const rejectPrompt = lead?.prompts.find((p) =>
			p.includes("Human rejection feedback"),
		)
		expect(rejectPrompt).toContain("[Command Center]")
		expect(rejectPrompt).toContain("rejected at the Acceptance gate")
		expect(rejectPrompt).toContain("Needs more polish")
		expect(rejectPrompt).toContain("Call write_plan")
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

	test("host attachment gate parks a drive before dispatch", async () => {
		const lock = new RecordingLock()
		const store = new InMemoryStore()
		const gated = new Orchestrator({
			store,
			worktreeProvider: new FakeWorktreeProvider(),
			driverLock: lock,
			canDriveMission: () => false,
			sessionRunner: (bus) => new FakeSessionRunner(bus),
		})

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

		await gated.resumeMission("m1")

		expect((await store.readPlan("m1"))?.items[0]?.status).toBe("pending")
		expect(gated.isMissionDriveParked("m1")).toBe(true)
		expect(lock.releaseCalls).toBe(1)
	})

	test("an attach-parked drive is cleared and restarted by an explicit resume", async () => {
		const lock = new RecordingLock()
		const store = new InMemoryStore()
		const wt = new FakeWorktreeProvider()
		let attachedToLead = false
		const gated = new Orchestrator({
			store,
			worktreeProvider: wt,
			driverLock: lock,
			canDriveMission: () => attachedToLead,
			sessionRunner: (bus) =>
				new FakeSessionRunner(bus, {
					onPrompt: async (session) => {
						if (session.who.roleName === "work_item_owner") {
							await simulateRequestReview(
								bus,
								session.who.missionId,
								session.who.workItemId!,
								"done after re-attach",
							)
							return
						}
						await simulateReviewWorkItem(
							store,
							bus,
							wt,
							session.who.missionId,
							1,
							"accept",
						)
					},
				}),
		})

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

		await gated.resumeMission("m1")
		expect((await store.readPlan("m1"))?.items[0]?.status).toBe("pending")
		expect(gated.isMissionDriveParked("m1")).toBe(true)

		attachedToLead = true
		await gated.resumeMission("m1", { force: false })

		expect(gated.isMissionDriveParked("m1")).toBe(false)
		expect(lock.acquireCalls).toEqual([{ force: true }, { force: false }])
		expect(lock.releaseCalls).toBe(2)
		expect((await store.readPlan("m1"))?.items[0]?.status).toBe("accepted")
		expect((await store.readMission("m1"))?.status).toBe("ready_for_acceptance")
	})

	test("parkMissionDrive aborts active sessions and stops before lead review", async () => {
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
						if (session.who.roleName !== "work_item_owner") return
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
					},
				}),
		})

		const drive = orch.resumeMission("m1")
		await ownerStartedP
		expect(orch.getActiveSession("m1", "work_item_owner", 1)).toBeDefined()
		orch.parkMissionDrive("m1")
		expect(orch.getActiveSession("m1", "work_item_owner", 1)).toBeUndefined()
		releaseOwner()

		await drive

		expect((await store.readPlan("m1"))?.items[0]?.status).toBe(
			"ready_for_review",
		)
		expect((await store.readMission("m1"))?.status).toBe("in_progress")
		expect(orch.isMissionDriveParked("m1")).toBe(true)
		expect(lock.releaseCalls).toBe(1)
	})

	test("a prompt rejection caused by parking is swallowed as a clean park", async () => {
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

		let leadReviewStarted!: () => void
		let rejectLeadReview!: () => void
		const leadReviewStartedP = new Promise<void>((resolve) => {
			leadReviewStarted = resolve
		})
		const leadReviewRejectedP = new Promise<void>((resolve) => {
			rejectLeadReview = resolve
		})

		const orch = new Orchestrator({
			store,
			worktreeProvider: wt,
			driverLock: lock,
			sessionRunner: (bus) =>
				new FakeSessionRunner(bus, {
					onPrompt: async (session) => {
						if (session.who.roleName === "work_item_owner") {
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
							return
						}
						if (session.who.roleName === "mission_lead") {
							leadReviewStarted()
							await leadReviewRejectedP
							throw new Error(
								"Visible Command Center lead session switched before the turn settled",
							)
						}
					},
				}),
		})

		const drive = orch.resumeMission("m1")
		await leadReviewStartedP
		expect((await store.readPlan("m1"))?.items[0]?.status).toBe(
			"ready_for_review",
		)

		orch.parkMissionDrive("m1")
		rejectLeadReview()
		await drive

		expect((await store.readMission("m1"))?.status).toBe("in_progress")
		expect((await store.readPlan("m1"))?.items[0]?.status).toBe(
			"ready_for_review",
		)
		expect(orch.isMissionDriveParked("m1")).toBe(true)
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
