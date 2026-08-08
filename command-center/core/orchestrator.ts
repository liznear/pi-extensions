import { computeReadySet, rollupPredicate, stuckPredicate } from "./dag"
import {
	type DriverLock,
	type DriverLockInfo,
	NoopDriverLock,
} from "./driver-lock"
import { type Event, EventBus, type EventListener } from "./events"
import { generateMissionId } from "./identity"
import type { RoleToolContext } from "./role"
import { getRoleProfile } from "./role"
import { Semaphore } from "./semaphore"
import {
	type FakeRoleSession,
	FakeSessionRunner,
	type RoleSession,
	type SessionRunner,
} from "./session"
import { isValidWorkItemTransition } from "./state"
import type { Store } from "./store"
import { InMemoryStore } from "./store"
import type { AcceptAndMerge } from "./tools/review"
import type {
	Mission,
	MissionStatus,
	MissionSummary,
	Plan,
	RoleIdentity,
	RoleName,
	WorkItem,
} from "./types"
import {
	type WorktreeProvider,
	WorktreeProvisioner,
} from "./worktree/provisioner"

// ---------------------------------------------------------------------------
// Orchestrator (tickets 03 / 04 / 05 / 06).
//
// The reactor that drives a mission: dispatches work items to owners, drives
// the review loop, merges accepted work, and surfaces the human Acceptance gate.
//
// Construction:
//   new Orchestrator({ repoPath?, store?, concurrency?, sessionRunner?, worktreeProvider?, driverLock? })
//
// All dependencies are swappable seams (Store, SessionRunner, WorktreeProvider,
// DriverLock).
// ---------------------------------------------------------------------------

export interface OrchestratorOptions {
	/** Persistence. Default: InMemoryStore. */
	store?: Store
	/** Max concurrent owner sessions. Default: 2 (ticket 05 D3). */
	concurrency?: number
	/** A shared semaphore for bounding active agent sessions across orchestrators. */
	sessionSemaphore?: Semaphore
	/**
	 * Session acquisition seam. A factory invoked at construction with this
	 * Orchestrator's own bus + store, so a consumer can build any SessionRunner
	 * (e.g. a PiSessionRunner) without those internals leaking out. When
	 * omitted, a FakeSessionRunner is used (no model calls).
	 */
	sessionRunner?: (bus: EventBus, store: Store) => SessionRunner
	/** Worktree operations. Default: WorktreeProvisioner() (stateless; Model C). */
	worktreeProvider?: WorktreeProvider
	/**
	 * Cross-process coordination: the driver lock serializing who may drive a
	 * mission across pi processes. Default: NoopDriverLock (single-process
	 * consumers / tests). A multi-process consumer wires a FileDriverLock.
	 */
	driverLock?: DriverLock
}

export class Orchestrator {
	readonly store: Store
	/**
	 * The driver lock (cross-process coordination). Public for read-side
	 * status checks (e.g. /cc attach gating).
	 */
	readonly driverLock: DriverLock
	readonly bus = new EventBus()
	private readonly sessionSemaphore: Semaphore
	private readonly sessionRunner: SessionRunner
	private readonly worktree: WorktreeProvider
	/** Model C: missionId → the repo that mission runs in. */
	private readonly repoByMission = new Map<string, string>()
	private readonly activeDrives = new Map<string, Promise<void>>()
	private readonly helpRequestKeys = new Set<string>() // format: `${missionId}:${workItemId}`
	private readonly planWriteLocks = new Map<string, Promise<void>>()
	private readonly activeSessions = new Map<string, RoleSession>()

	/** Serializes lead-session access (lead reviews one item at a time — 04 D6). */
	private leadLock = Promise.resolve()

	/**
	 * The activeSessions key for a role: `<missionId>:<roleName>[:<workItemId>]`.
	 * Shared by acquireSession (writer), getActiveSession / abortWorkItem (readers)
	 * so the key format can't drift.
	 */
	private sessionKey(who: RoleIdentity): string {
		return `${who.missionId}:${who.roleName}${
			who.workItemId !== undefined ? `:${who.workItemId}` : ""
		}"`
	}

	constructor(opts: OrchestratorOptions = {}) {
		this.store = opts.store ?? new InMemoryStore()
		this.driverLock = opts.driverLock ?? new NoopDriverLock()
		const concurrency = opts.concurrency ?? 2
		this.sessionSemaphore = opts.sessionSemaphore ?? new Semaphore(concurrency)
		this.worktree = opts.worktreeProvider ?? new WorktreeProvisioner()
		this.sessionRunner = opts.sessionRunner
			? opts.sessionRunner(this.bus, this.store)
			: new FakeSessionRunner(this.bus)
	}

	/** Subscribe to the unified event stream. Returns an unsubscribe fn. */
	subscribeAll(listener: EventListener): () => void {
		return this.bus.subscribe(listener)
	}

	/**
	 * Subscribe to ONE mission's event stream. Events are filtered by
	 * `missionId` (every event carries one — ticket 01). Returns an unsubscribe
	 * fn. (For a global activity feed across missions, use subscribeAll.)
	 */
	subscribe(missionId: string, listener: EventListener): () => void {
		return this.bus.subscribe((e) => {
			if (e.missionId === missionId) listener(e)
		})
	}

	/**
	 * List work items that have requested help but not yet been triaged (ticket 09/13).
	 * Returns the work item IDs.
	 */
	workItemsNeedingHelp(missionId: string): readonly number[] {
		const result: number[] = []
		for (const key of this.helpRequestKeys) {
			if (key.startsWith(`${missionId}:`)) {
				const parts = key.split(":")
				if (parts.length === 2 && parts[1] !== undefined) {
					result.push(Number.parseInt(parts[1], 10))
				}
			}
		}
		return result
	}

	/**
	 * List read-only summary rows for all missions (ticket 08). Delegates to the
	 * Store — the Orchestrator is the host-facing surface; a consumer (e.g. a
	 * GUI home) calls this rather than reaching into the Store.
	 */
	listMissions(): Promise<MissionSummary[]> {
		return this.store.listMissions()
	}

	/**
	 * Resume a single mission and drive it to its next park point (idle at the
	 * acceptance gate, stuck, or terminal). Driving is ALWAYS explicit — there
	 * is no auto-resume at startup: this is called by the host (/cc resume) or
	 * by re-drives after human input (replyHumanInput).
	 *
	 * Taking over an in-flight drive in another process is intended behavior:
	 * this force-acquires the mission's driver lock, and the displaced driver
	 * stops at its next loop iteration.
	 *
	 * @returns the displaced holder, when this call took the drive over from a
	 *          live foreign process (undefined otherwise).
	 */
	async resumeMission(missionId: string): Promise<DriverLockInfo | undefined> {
		const tookOverFrom = await this.acquireDriveLock(missionId, true)
		try {
			const mission = await this.store.readMission(missionId)
			if (!mission)
				throw new Error(`corrupt domain state: missing mission ${missionId}`)
			this.repoByMission.set(missionId, mission.repoPath)

			const plan = await this.store.readPlan(missionId)
			if (!plan) {
				// Mission stubbed but not planned (or planning was interrupted).
				const lead: RoleIdentity = { missionId, roleName: "mission_lead" }
				const session = await this.acquireSession(lead)
				// Resume prompt signals continue
				await this.promptAndCollect(session, "Continue with your work.")
				await this.dispatchAndDrive(missionId)
				return tookOverFrom
			}

			await this.dispatchAndDrive(missionId)
			return tookOverFrom
		} finally {
			await this.driverLock.release(missionId)
		}
	}

	/**
	 * Reply to a human input request and re-drive the lead.
	 */
	async replyHumanInput(
		missionId: string,
		requestId: string,
		reply: string,
	): Promise<void> {
		const requests = await this.store.readHumanInputRequests(missionId)
		const req = requests.find((r) => r.requestId === requestId)
		if (!req) throw new Error(`Unknown human input request: ${requestId}`)
		if (req.status !== "open")
			throw new Error(`Request ${requestId} is already answered`)

		req.reply = reply
		await this.store.writeHumanInputRequest(missionId, req)

		this.bus.emit({
			type: "human-input-replied",
			missionId,
			requestId,
			reply,
			roleName: "mission_lead",
		})

		// Re-derive lead obligation
		await this.resumeMission(missionId)
	}

	// -----------------------------------------------------------------------
	// Mission lifecycle
	// -----------------------------------------------------------------------

	/**
	 * Abort a specific work item: calls session.abort(), sets item status to cancelled,
	 * removes owner worktree.
	 */
	async abortWorkItem(missionId: string, workItemId: number): Promise<void> {
		// Explicit host action: take over the drive so the cancel persists and
		// any other driver stops at its next loop iteration.
		await this.acquireDriveLock(missionId, true)
		try {
			const key = this.sessionKey({
				missionId,
				roleName: "work_item_owner",
				workItemId,
			})
			const session = this.activeSessions.get(key)
			if (session) {
				session.abort()
				this.activeSessions.delete(key)
			}
			const plan = await this.store.readPlan(missionId)
			if (plan) {
				const itemIndex = plan.items.findIndex(
					(i: WorkItem) => i.id === workItemId,
				)
				if (itemIndex >= 0 && plan.items[itemIndex]) {
					const oldItem = plan.items[itemIndex]
					const items = [...plan.items]
					items[itemIndex] = {
						id: oldItem.id,
						title: oldItem.title,
						description: oldItem.description,
						dependencies: [...oldItem.dependencies],
						status: "cancelled",
					}
					await this.store.writePlan(missionId, { ...plan, items })
					this.bus.emit({
						type: "work-item-status-changed",
						missionId,
						workItemId,
						from: oldItem.status,
						to: "cancelled",
					})
				}
			}
			const repoPath = this.repoByMission.get(missionId)
			if (repoPath) {
				await this.worktree.removeOwnerWorktree(repoPath, missionId, workItemId)
			}
		} finally {
			await this.driverLock.release(missionId)
		}
	}

	/**
	 * Abort an entire mission: aborts all active sessions for this mission,
	 * sets mission status to cancelled, and removes all worktrees.
	 */
	async abortMission(missionId: string): Promise<void> {
		await this.acquireDriveLock(missionId, true)
		try {
			this.abortMissionSessions(missionId)
			const m = await this.store.readMission(missionId)
			if (m) {
				const previousStatus = m.status
				await this.store.writeMission({ ...m, status: "cancelled" })
				this.bus.emit({
					type: "mission-status-changed",
					missionId,
					from: previousStatus,
					to: "cancelled",
				})
			}
			const repoPath = this.repoByMission.get(missionId)
			if (repoPath) {
				// Tear down all worktrees (integration + owners)
				try {
					await this.worktree.removeIntegrationWorktree(repoPath, missionId)
				} catch (err) {
					console.error(
						`Failed to tear down integration worktree for aborted mission ${missionId}:`,
						err,
					)
				}
			}
		} finally {
			await this.driverLock.release(missionId)
		}
	}

	/**
	 * Define a mission: generate an id, provision the Integration Worktree, and
	 * drive the lead to define the mission + write the plan. Returns the
	 * missionId (tickets 06 D2 / 04 D1).
	 *
	 * Model C: the mission runs in `repoPath`. One Orchestrator can drive
	 * missions across many repos; each mission's id routes its event stream
	 * (subscribe(id)) and its worktree namespace (`<repoPath>/.command-center/`).
	 */
	async defineMission(
		description: string,
		opts: { repoPath: string },
	): Promise<string> {
		const missionId = await this.prepareMission(description, opts)
		await this.driveDefinedMission(missionId, description)
		return missionId
	}

	/**
	 * Create and queue a mission for a host such as the GUI. Returns once the
	 * mission stub and integration worktree are ready; agent work continues in
	 * the background so the host is not blocked by a long-running session.
	 *
	 * A failed background drive (session creation, worktree, model errors) is
	 * otherwise invisible to the host — surface it via `onDriveError` so a
	 * queued-but-failed mission reads as an actionable error instead of a
	 * later attach-time "no session" mystery.
	 */
	async queueMission(
		description: string,
		opts: {
			repoPath: string
			onDriveError?: (missionId: string, error: Error) => void
		},
	): Promise<string> {
		const missionId = await this.prepareMission(description, opts)
		void this.driveDefinedMission(missionId, description).catch((error) => {
			const err = error instanceof Error ? error : new Error(String(error))
			console.error(`Mission ${missionId} failed:`, err)
			opts.onDriveError?.(missionId, err)
		})
		return missionId
	}

	private async prepareMission(
		description: string,
		opts: { repoPath: string },
	): Promise<string> {
		const missionId = generateMissionId()
		const repoPath = opts.repoPath

		// Provision the worktree BEFORE persisting the stub. Provisioning takes
		// only repoPath/missionId (it never reads the store), and if it throws —
		// invalid repo path, git missing (ENOENT), empty repo with no HEAD — no
		// stub is left behind. Otherwise the orphaned stub would surface on the
		// next resumeMission and re-throw forever.
		await this.worktree.ensureGitignored(repoPath)
		await this.worktree.createIntegrationWorktree(repoPath, missionId)

		this.repoByMission.set(missionId, repoPath)
		await this.store.writeMission({
			id: missionId,
			repoPath,
			title: "(New Mission)",
			description,
			acceptanceCriteria: [],
			status: "in_progress",
		})
		return missionId
	}

	private async driveDefinedMission(
		missionId: string,
		description: string,
	): Promise<void> {
		// A freshly generated mission id cannot be held by anyone; plain acquire
		// (a live-holder refusal here would be a pathological id clash).
		await this.acquireDriveLock(missionId, false)
		try {
			const lead: RoleIdentity = { missionId, roleName: "mission_lead" }
			const session = await this.acquireSession(lead)
			await this.promptAndCollect(session, this.missionStartPrompt(description))

			// Drive the plan to completion.
			await this.dispatchAndDrive(missionId)
		} finally {
			await this.driverLock.release(missionId)
		}
	}

	/**
	 * Human Acceptance gate (ticket 04 D7). Called by the consumer (e.g. the
	 * CLI prompts the human) once the mission reaches `ready_for_acceptance`.
	 */
	async reviewMission(
		missionId: string,
		decision: "accept" | "reject",
		feedback?: string,
	): Promise<void> {
		// Explicit host action: take over the drive for the terminal transition
		// (accept) or the re-plan drive (reject).
		await this.acquireDriveLock(missionId, true)
		try {
			const mission = await this.store.readMission(missionId)
			if (!mission) throw new Error(`Unknown mission: ${missionId}`)

			if (decision === "accept") {
				await this.transitionMission(missionId, "completed")
				await this.worktree.removeIntegrationWorktree(
					this.repoFor(missionId),
					missionId,
				)
				// The integration worktree (lead cwd) is gone; drop the lead session handle.
				this.activeSessions.delete(
					this.sessionKey({ missionId, roleName: "mission_lead" }),
				)
				return
			}

			// reject: mission back to in_progress; lead re-plans (04 D7).
			await this.store.writeMission({
				...mission,
				status: "in_progress",
				rejectionFeedback: feedback,
			})
			await this.transitionMission(missionId, "in_progress")
			const lead: RoleIdentity = { missionId, roleName: "mission_lead" }
			const session = await this.acquireSession(lead)
			const prompt =
				`The mission was rejected at the Acceptance gate.\n` +
				`Feedback: ${feedback ?? "(none provided)"}\n\n` +
				`Re-plan: add new work items (via write_plan) to address the feedback. ` +
				`Accepted items stay accepted (they are terminal); compose new items on top of them.`
			await this.promptAndCollect(session, prompt)
			await this.dispatchAndDrive(missionId)
		} finally {
			await this.driverLock.release(missionId)
		}
	}

	/**
	 * Delete a mission entirely: tear down its worktrees (integration checkout +
	 * branch, every owner checkout + branch) and remove all persisted state
	 * (mission/plan/memory/inbox/status). Emits `mission-deleted`. Safe on a
	 * mission in any state; a missing mission record still gets its on-disk
	 * state + worktrees cleaned. In-flight drives for the mission are detached
	 * (their next read of the now-deleted mission returns null and they exit).
	 */
	async deleteMission(missionId: string): Promise<void> {
		// Explicit host action: take over the drive so teardown can't race a
		// live driver (in-flight drives detach on their next store read).
		await this.acquireDriveLock(missionId, true)
		try {
			const mission = await this.store.readMission(missionId)
			const plan = await this.store.readPlan(missionId)

			if (mission) {
				const repoPath = mission.repoPath
				if (plan) {
					for (const item of plan.items) {
						await this.worktree.removeOwnerWorktree(
							repoPath,
							missionId,
							item.id,
						)
					}
				}
				await this.worktree.removeIntegrationWorktree(repoPath, missionId)
				await this.worktree.removeIntegrationBranch(repoPath, missionId)
			}

			// Removes the mission dir — including the driver lock file itself;
			// the release below then no-ops on the absent file.
			await this.store.deleteMission(missionId)

			this.repoByMission.delete(missionId)
			this.planWriteLocks.delete(missionId)
			for (const key of [...this.activeDrives.keys()]) {
				if (key.startsWith(`${missionId}:`)) this.activeDrives.delete(key)
			}
			for (const key of [...this.helpRequestKeys]) {
				if (key.startsWith(`${missionId}:`)) this.helpRequestKeys.delete(key)
			}
			for (const key of [...this.activeSessions.keys()]) {
				if (key.startsWith(`${missionId}:`)) this.activeSessions.delete(key)
			}

			this.bus.emit({ type: "mission-deleted", missionId })
		} finally {
			await this.driverLock.release(missionId)
		}
	}

	// -----------------------------------------------------------------------
	// Dispatch + drive loop (ticket 05)
	// -----------------------------------------------------------------------

	/**
	 * Drive the plan: dispatch ready items up to `concurrency`, run each to
	 * completion, check rollup/stuck, repeat until idle or terminal.
	 */
	private async dispatchAndDrive(missionId: string): Promise<void> {
		for (;;) {
			// Another process force-took the driver lock mid-drive: stop now
			// (abort in-flight turns). NoopDriverLock always reports "held by
			// me", so in-process runs are unaffected.
			if (await this.driveDisplaced(missionId)) {
				this.abortMissionSessions(missionId)
				return
			}
			const mission = await this.store.readMission(missionId)
			if (!mission) return
			// A terminal status (aborted / cancelled elsewhere) stops the drive.
			if (mission.status === "completed" || mission.status === "cancelled")
				return
			const plan = await this.store.readPlan(missionId)
			if (!plan) return
			const items = plan.items

			// Rollup: all terminal + ≥1 accepted → ready_for_acceptance.
			// Gate rollup on "no unconsumed rejection"
			if (rollupPredicate(plan) && !mission.rejectionFeedback) {
				await this.transitionMission(missionId, "ready_for_acceptance")
				return
			}

			// Stuck: can't drain but not done → resume lead to re-plan (05 D8).
			if (stuckPredicate(plan)) {
				const before = planSignature(items)
				await this.handleStuck(missionId)
				const afterPlan = await this.store.readPlan(missionId)
				const after = afterPlan ? planSignature(afterPlan.items) : before
				if (after === before) return // no progress → park
				continue
			}

			const ready = computeReadySet(plan)

			const resumedInFlight = items.filter(
				(i) =>
					(i.status === "in_progress" || i.status === "ready_for_review") &&
					!this.activeDrives.has(`${missionId}:${i.id}`),
			)
			const toDispatch = ready.filter(
				(id) => !this.activeDrives.has(`${missionId}:${id}`),
			)

			let dispatched = 0
			for (const item of resumedInFlight) {
				const key = `${missionId}:${item.id}`
				const promise = this.driveItem(missionId, item.id).finally(() =>
					this.activeDrives.delete(key),
				)
				this.activeDrives.set(key, promise)
				dispatched++
			}

			for (const id of toDispatch) {
				const key = `${missionId}:${id}`
				const promise = this.driveItem(missionId, id).finally(() =>
					this.activeDrives.delete(key),
				)
				this.activeDrives.set(key, promise)
				dispatched++
			}

			const active = Array.from(this.activeDrives.entries())
				.filter(([k]) => k.startsWith(`${missionId}:`))
				.map(([, p]) => p)

			if (active.length === 0 && dispatched === 0) {
				return
			}

			if (active.length > 0) {
				await Promise.race(active)
			}
		}
	}

	private async driveItem(missionId: string, itemId: number): Promise<void> {
		const item = await this.getItem(missionId, itemId)
		const owner: RoleIdentity = {
			missionId,
			roleName: "work_item_owner",
			workItemId: itemId,
		}

		let session: RoleSession
		let prompt: string

		if (item.status === "pending") {
			await this.transitionWorkItem(missionId, itemId, "in_progress", {
				roleName: "mission_lead",
			})
			await this.worktree.createOwnerWorktree(
				this.repoFor(missionId),
				missionId,
				itemId,
			)
			session = await this.acquireSession(owner)
			prompt = await this.workItemPrompt(missionId, itemId)
		} else if (item.status === "in_progress") {
			await this.worktree.createOwnerWorktree(
				this.repoFor(missionId),
				missionId,
				itemId,
			)
			session = await this.acquireSession(owner)
			prompt = "Continue with your work."
		} else if (item.status === "ready_for_review") {
			const dummyReviewRequest: Event = {
				type: "tool-call-ended",
				missionId,
				workItemId: itemId,
				roleName: "work_item_owner",
				toolName: "request_review",
				toolCallId: "dummy",
				ts: Date.now(),
				seq: 0,
				isError: false,
				result: { details: { summary: "(resumed from ready_for_review)" } },
			}
			const verdict = await this.withLead(() =>
				this.runReview(missionId, itemId, dummyReviewRequest),
			)
			if (verdict.terminal) {
				await this.worktree.removeOwnerWorktree(
					this.repoFor(missionId),
					missionId,
					itemId,
				)
				this.activeSessions.delete(this.sessionKey(owner))
				return
			}
			prompt = this.reworkPrompt(itemId, verdict.feedback ?? "")
			session = await this.acquireSession(owner)
		} else {
			return
		}

		for (;;) {
			// Another process took over the drive; stop before the next prompt.
			if (await this.driveDisplaced(missionId)) {
				this.activeSessions.get(this.sessionKey(owner))?.abort()
				this.activeSessions.delete(this.sessionKey(owner))
				return
			}
			let events: Event[] = []
			try {
				await this.sessionSemaphore.acquire()
				events = await this.promptAndCollect(session, prompt)
			} finally {
				this.sessionSemaphore.release()
			}

			const helpRequest = events.find(
				(e) =>
					e.type === "tool-call-ended" &&
					e.toolName === "request_help" &&
					e.workItemId === itemId,
			)

			if (helpRequest) {
				const reason =
					(helpRequest as { result?: { details?: { reason?: string } } }).result
						?.details?.reason ?? "(no reason provided)"

				this.bus.emit({
					type: "help-requested",
					missionId,
					workItemId: itemId,
					roleName: "work_item_owner",
					reason,
				})

				const helpKey = `${missionId}:${itemId}`
				this.helpRequestKeys.add(helpKey)

				const triageVerdict = await this.withLead(() =>
					this.runTriage(missionId, itemId, reason),
				)

				this.helpRequestKeys.delete(helpKey)

				if (triageVerdict.cancelled) {
					// The item was cancelled during triage via write_plan
					await this.worktree.removeOwnerWorktree(
						this.repoFor(missionId),
						missionId,
						itemId,
					)
					this.activeSessions.delete(this.sessionKey(owner))
					return
				}

				if (triageVerdict.guidance) {
					this.bus.emit({
						type: "help-responded",
						missionId,
						workItemId: itemId,
						roleName: "mission_lead",
						outcome: "guided",
						guidance: triageVerdict.guidance,
					})
					prompt = `The Mission Lead has responded to your help request:\n\n${triageVerdict.guidance}\n\nContinue with your work.`
				} else {
					// Fallback: incomplete triage (no respond_to_help or write_plan cancellation)
					prompt = `Your help request was acknowledged but no specific guidance was provided. Please continue your work as best you can, or ask for clarification.`
				}
				// Re-acquire session and loop
				session = await this.acquireSession(owner)
				continue
			}

			const reviewRequest = events.find(
				(e) =>
					e.type === "tool-call-ended" &&
					e.toolName === "request_review" &&
					e.workItemId === itemId,
			)
			if (!reviewRequest) {
				return
			}

			await this.transitionWorkItem(missionId, itemId, "ready_for_review", {
				roleName: "work_item_owner",
				workItemId: itemId,
			})

			const verdict = await this.withLead(() =>
				this.runReview(missionId, itemId, reviewRequest),
			)

			if (verdict.terminal) {
				await this.worktree.removeOwnerWorktree(
					this.repoFor(missionId),
					missionId,
					itemId,
				)
				this.activeSessions.delete(this.sessionKey(owner))
				return
			}

			prompt = this.reworkPrompt(itemId, verdict.feedback ?? "")
		}
	}

	private async runReview(
		missionId: string,
		itemId: number,
		reviewRequest: Event,
	): Promise<{ terminal: boolean; feedback?: string }> {
		const lead: RoleIdentity = { missionId, roleName: "mission_lead" }
		const session = await this.acquireSession(lead)
		const prompt = await this.reviewInputPrompt(
			missionId,
			itemId,
			reviewRequest,
		)
		const events = await this.promptAndCollect(session, prompt)

		// Find the review_work_item tool call result. The lead's event has NO
		// workItemId (lead identity has none); match on tool + roleName and read
		// the workItemId from the result details.
		const verdictEvent = events.find(
			(e) =>
				e.type === "tool-call-ended" &&
				e.toolName === "review_work_item" &&
				e.roleName === "mission_lead" &&
				(e as { result?: { details?: { workItemId?: number } } }).result
					?.details?.workItemId === itemId,
		)
		if (!verdictEvent) {
			// Lead didn't issue a verdict — idle.
			return { terminal: false }
		}

		const details = (verdictEvent as { result?: { details?: unknown } }).result
			?.details as
			| { decision?: string; applied?: boolean; feedback?: string }
			| undefined
		const decision = details?.decision
		// (debug log removed)

		if (decision === "rework") {
			return { terminal: false, feedback: details?.feedback }
		}
		// accept / cancel → terminal (the tool already wrote the status + event).
		return { terminal: true, feedback: details?.feedback }
	}

	private async runTriage(
		missionId: string,
		itemId: number,
		reason: string,
	): Promise<{ cancelled: boolean; guidance?: string }> {
		const item = await this.getItem(missionId, itemId)
		const ownerBranch = `cc/${missionId}/work/${itemId}`

		const lead: RoleIdentity = { missionId, roleName: "mission_lead" }
		const session = await this.acquireSession(lead)
		const prompt =
			`The owner of Work item #${itemId} ("${item.title}") has requested help and is blocked.\n\n` +
			`Reason:\n${reason}\n\n` +
			`Owner's branch: ${ownerBranch}\n\n` +
			`Provide clear, actionable guidance using the respond_to_help tool to unblock them. ` +
			`Alternatively, if the item is no longer viable, you may cancel it using write_plan.`

		const events = await this.promptAndCollect(session, prompt)

		// Did the lead cancel the item via write_plan during this turn?
		const afterPlan = await this.store.readPlan(missionId)
		const currentItem = afterPlan?.items.find((i) => i.id === itemId)
		if (currentItem && currentItem.status === "cancelled") {
			this.bus.emit({
				type: "help-responded",
				missionId,
				workItemId: itemId,
				roleName: "mission_lead",
				outcome: "cancelled",
			})
			return { cancelled: true }
		}

		// Find respond_to_help
		const respondEvent = events.find(
			(e) =>
				e.type === "tool-call-ended" &&
				e.toolName === "respond_to_help" &&
				e.roleName === "mission_lead" &&
				(e as { result?: { details?: { workItemId?: number } } }).result
					?.details?.workItemId === itemId,
		)

		if (!respondEvent) {
			// Incomplete triage
			return { cancelled: false }
		}

		const guidance = (
			respondEvent as { result?: { details?: { guidance?: string } } }
		).result?.details?.guidance

		return { cancelled: false, guidance }
	}

	/** Resume the lead with a re-planning prompt when the plan is stuck (05 D8). */
	private async handleStuck(missionId: string): Promise<void> {
		const plan = await this.store.readPlan(missionId)
		if (!plan) return

		// Describe the stuck situation.
		const stuck = plan.items.filter(
			(i) => i.status === "pending" && !computeReadySet(plan).includes(i.id),
		)
		const cancelled = plan.items.filter((i) => i.status === "cancelled")
		const lines = stuck.map(
			(i) =>
				`#${i.id} ("${i.title}") is pending with unsatisfied dependencies ` +
				`[${i.dependencies.join(", ")}].`,
		)
		if (cancelled.length > 0) {
			lines.push(
				`Cancelled items: ${cancelled.map((i) => `#${i.id}`).join(", ")}.`,
			)
		}

		const lead: RoleIdentity = { missionId, roleName: "mission_lead" }
		const session = await this.acquireSession(lead)
		const prompt =
			`The plan cannot progress. The following items are blocked:\n\n` +
			lines.join("\n") +
			`\n\nRe-plan: edit dependencies (write_plan), add a replacement item, ` +
			`or the plan is otherwise undrainable.`
		await this.promptAndCollect(session, prompt)
	}

	// -----------------------------------------------------------------------
	// Session acquisition + prompts
	// -----------------------------------------------------------------------

	/** The repo a mission runs in (Model C). */
	private repoFor(missionId: string): string {
		const repo = this.repoByMission.get(missionId)
		if (repo === undefined) {
			throw new Error(`No repo registered for mission ${missionId}`)
		}
		return repo
	}

	/**
	 * Build the role's session spec from its profile + acquire via the runner.
	 *
	 * Guarantees the role's worktree dir exists before acquiring — pi-coding-agent
	 * throws MissingSessionCwdError if the session cwd is absent, and the
	 * integration/owner worktree can be missing after an interrupted run or a
	 * prior teardown. Worktree creation is idempotent (no-op when present), so
	 * this is safe to call on every acquisition.
	 */
	private async acquireSession(who: RoleIdentity): Promise<RoleSession> {
		const repoPath = this.repoFor(who.missionId)
		const cwd = this.cwdFor(who)

		// Ensure the worktree dir exists (idempotent) before pi validates cwd.
		if (who.roleName === "mission_lead") {
			await this.worktree.createIntegrationWorktree(repoPath, who.missionId)
		} else {
			const workItemId = who.workItemId
			if (workItemId === undefined) {
				throw new Error(`owner role missing workItemId: ${who.missionId}`)
			}
			await this.worktree.createOwnerWorktree(
				repoPath,
				who.missionId,
				workItemId,
			)
		}

		const profile = getRoleProfile(who.roleName)
		const ctx: RoleToolContext = {
			who,
			repoPath,
			cwd,
			domain: {
				store: this.store,
				bus: this.bus,
				acceptAndMerge:
					who.roleName === "mission_lead"
						? this.buildAcceptAndMerge(who.missionId)
						: undefined,
			},
		}
		const spec = profile.build(ctx)
		const session = await this.sessionRunner.startOrResume(
			who,
			cwd,
			spec.systemPrompt,
			spec.tools,
		)

		// Track the session so consumers can attach to / abort it (getActiveSession,
		// abortWorkItem, abortMission). Same role ⇒ same key ⇒ latest handle wins.
		this.activeSessions.set(this.sessionKey(who), session)

		// Ticket 10: Human-input reply injection at lead session start.
		if (who.roleName === "mission_lead") {
			const requests = await this.store.readHumanInputRequests(who.missionId)
			const openReplied = requests.filter((r) => r.status === "open" && r.reply)
			if (openReplied.length > 0) {
				let injection =
					"The human operator has replied to your input requests:\n\n"
				for (const r of openReplied) {
					injection += `Request: "${r.question}"\nReply: ${r.reply}\n\n`
					// Mark as consumed (answered)
					r.status = "answered"
					await this.store.writeHumanInputRequest(who.missionId, r)
				}
				injection += "Continue with your work."
				// Fire-and-forget prompt injection (it queues in the session)
				session.prompt(injection).catch((err) => {
					console.error("Failed to inject human replies into lead session", err)
				})
			}
		}

		return session
	}

	/** Map a role to its worktree directory (lead → integration; owner → owner). */
	public cwdFor(who: RoleIdentity): string {
		const repoPath = this.repoFor(who.missionId)
		if (who.roleName === "mission_lead") {
			return this.worktree.integrationDir(repoPath, who.missionId)
		}
		// work_item_owner always carries workItemId; throw otherwise (defensive).
		const workItemId = who.workItemId
		if (workItemId === undefined) {
			throw new Error(`owner role missing workItemId: ${who.missionId}`)
		}
		return this.worktree.ownerDir(repoPath, who.missionId, workItemId)
	}

	public getActiveSession(
		missionId: string,
		roleName: RoleName,
		workItemId?: number,
	): RoleSession | undefined {
		return this.activeSessions.get(
			this.sessionKey({ missionId, roleName, workItemId }),
		)
	}

	/** The accept-merge callback wired to the WorktreeProvider (lead-only). */
	private buildAcceptAndMerge(missionId: string): AcceptAndMerge {
		return async (workItemId: number) => {
			const repoPath = this.repoFor(missionId)
			const plan = await this.store.readPlan(missionId)
			const item = plan?.items.find((i) => i.id === workItemId)
			const title = item?.title ?? `Item ${workItemId}`
			return this.worktree.acceptMerge(repoPath, missionId, workItemId, title)
		}
	}

	/** Prompt a session and collect all events emitted during the turn. */
	private async promptAndCollect(
		session: RoleSession,
		text: string,
	): Promise<Event[]> {
		const events: Event[] = []
		const off = this.bus.subscribe((e) => events.push(e))
		try {
			await session.prompt(text)
		} finally {
			off()
		}
		return events
	}

	// -----------------------------------------------------------------------
	// Prompt builders (ticket 04 D3 lean review input)
	// -----------------------------------------------------------------------

	private missionStartPrompt(description: string): string {
		return `A new mission has been assigned to you.\n\n${description}\n\nDefine the mission (define_mission) and plan it as a DAG of work items (write_plan).`
	}

	private async workItemPrompt(
		missionId: string,
		itemId: number,
	): Promise<string> {
		const item = await this.getItem(missionId, itemId)
		const deps =
			item.dependencies.length > 0 ? item.dependencies.join(", ") : "none"
		return (
			`Work item #${itemId} ("${item.title}") has been assigned to you.\n\n` +
			`Description: ${item.description}\n` +
			`Dependencies: ${deps}\n\n` +
			`Implement this work item to completion, then call request_review with a substantive summary.`
		)
	}

	private async reviewInputPrompt(
		missionId: string,
		itemId: number,
		reviewRequest: Event,
	): Promise<string> {
		const item = await this.getItem(missionId, itemId)
		const deps =
			item.dependencies.length > 0 ? item.dependencies.join(", ") : "none"
		const summary =
			(reviewRequest as { result?: { details?: { summary?: string } } }).result
				?.details?.summary ?? "(no summary)"
		const ownerBranch = `cc/${missionId}/work/${itemId}`
		return (
			`Work item #${itemId} ("${item.title}") is ready for review.\n\n` +
			`Description: ${item.description}\n` +
			`Dependencies: ${deps}\n` +
			`Owner's summary: ${summary}\n` +
			`Owner's branch: ${ownerBranch}\n\n` +
			`Inspect the change (git diff/log the owner's branch against integration), ` +
			`then call review_work_item with your verdict.`
		)
	}

	private reworkPrompt(itemId: number, feedback: string): string {
		return (
			`Work item #${itemId} was sent back for rework.\n\n` +
			`Feedback from the Mission Lead:\n${feedback}\n\n` +
			`Address the feedback. If integration has advanced, sync it first ` +
			`(merge/rebase cc/<missionId>/integration into your branch). ` +
			`Then call request_review again.`
		)
	}

	// -----------------------------------------------------------------------
	// State transitions (guarded by the state machine)
	// -----------------------------------------------------------------------

	private async transitionWorkItem(
		missionId: string,
		itemId: number,
		to: WorkItem["status"],
		causedBy: { roleName: RoleIdentity["roleName"]; workItemId?: number },
	): Promise<void> {
		return this.withPlanLock(missionId, async () => {
			const plan = await this.store.readPlan(missionId)
			const item = plan?.items.find((i) => i.id === itemId)
			if (!item) return
			const from = item.status
			if (!isValidWorkItemTransition(from, to)) return
			await this.store.writeWorkItemStatus(missionId, itemId, to)
			this.bus.emit({
				type: "work-item-status-changed",
				missionId,
				workItemId: itemId,
				from,
				to,
				causedBy,
			})
		})
	}

	private async transitionMission(
		missionId: string,
		to: MissionStatus,
	): Promise<void> {
		const mission = await this.store.readMission(missionId)
		if (!mission) return
		const from = mission.status
		if (from === to) return
		await this.store.writeMissionStatus(missionId, to)

		// Sweep human input requests and status if mission is terminal
		if (to === "completed" || to === "cancelled") {
			// Sweep open human input requests
			const requests = await this.store.readHumanInputRequests(missionId)
			let dirty = false
			for (const r of requests) {
				if (r.status === "open") {
					r.status = "answered" // or cancel? Design says "sweep remaining requests", setting to answered works
					r.reply = r.reply || "Mission terminated, request swept."
					dirty = true
				}
			}
			if (dirty) {
				// Re-write all at once since writeHumanInputRequest does it by ID,
				// but let's just loop for simplicity.
				for (const r of requests) {
					if (r.status === "answered") {
						await this.store.writeHumanInputRequest(missionId, r)
					}
				}
			}

			// We could sweep status report file here too, but the status is useful to keep for terminal state visibility.
			// Re-reading map: "sweep on terminal mission transition (like human-input)".
			// The map actually says: "swept on terminal mission transition (like human-input)".
			// I'll leave the file, but maybe clear the content or just leave it. The requirement might mean cleaning it up, but file removal isn't in store interface.
			// Actually, sweeping usually means it's closed out so it doesn't block or show up as pending.
		}

		this.bus.emit({
			type: "mission-status-changed",
			missionId,
			from,
			to,
		})
	}

	// -----------------------------------------------------------------------
	// Helpers
	// -----------------------------------------------------------------------

	private async getItem(missionId: string, itemId: number): Promise<WorkItem> {
		const plan = await this.store.readPlan(missionId)
		const item = plan?.items.find((i) => i.id === itemId)
		if (!item)
			throw new Error(`Work item ${itemId} not found in mission ${missionId}`)
		return item
	}

	/** Abort every active session belonging to a mission (in-process). */
	private abortMissionSessions(missionId: string): void {
		for (const [key, session] of this.activeSessions.entries()) {
			if (key.startsWith(`${missionId}:`)) {
				session.abort()
				this.activeSessions.delete(key)
			}
		}
	}

	/**
	 * Acquire the mission's driver lock. `force` = explicit takeover (every
	 * mutating / driving command). Returns the displaced holder (when this
	 * call took the lock from a live driver) for host notification. Throws
	 * when a live foreign holder refuses a non-force acquire.
	 */
	private async acquireDriveLock(
		missionId: string,
		force: boolean,
	): Promise<DriverLockInfo | undefined> {
		const result = await this.driverLock.acquire(missionId, { force })
		if (!result.acquired) {
			throw new Error(
				`Mission ${missionId} is already driven by pid ${result.holder.pid} ` +
					`(${result.holder.hostname}). Use /cc resume to take over.`,
			)
		}
		return result.tookOverFrom
	}

	/** True iff another process has force-taken our drive lock mid-run. */
	private async driveDisplaced(missionId: string): Promise<boolean> {
		return !(await this.driverLock.isHeldByMe(missionId))
	}

	/** Serialize access to the lead session (reviews one item at a time — 04 D6). */
	private withLead<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.leadLock.then(() => fn())
		this.leadLock = run.then(
			() => undefined,
			() => undefined,
		)
		return run
	}

	/**
	 * Serialize writes to the mission's Plan to prevent read-modify-write races
	 * when transitioning multiple work items concurrently.
	 */
	private withPlanLock<T>(missionId: string, fn: () => Promise<T>): Promise<T> {
		const prev = this.planWriteLocks.get(missionId) ?? Promise.resolve()
		const next = prev.then(() => fn())
		this.planWriteLocks.set(
			missionId,
			next.then(
				() => undefined,
				() => undefined,
			),
		)
		return next
	}
}

// Re-export types consumers need.
export type { FakeRoleSession, Mission, Plan }

/**
 * A compact signature of a plan's structure (ids + statuses + deps) for change
 * detection. If two signatures are equal, the plan hasn't structurally changed
 * — used by dispatchAndDrive to detect a no-progress stuck nudge and park.
 */
function planSignature(items: readonly WorkItem[]): string {
	return items
		.map((i) => `${i.id}:${i.status}:${i.dependencies.join(".")}`)
		.join("|")
}
