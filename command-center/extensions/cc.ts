import type {
	AgentSessionEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ThemeColor,
} from "@earendil-works/pi-coding-agent"
import { SessionManager } from "@earendil-works/pi-coding-agent"
import { renameOrcaTabTitle } from "../../lib/orca-terminal-title"
import {
	createAutoSessionRunner,
	isHerdrEnv,
	isOrcaEnv,
} from "../core/auto-session"
import { FileDriverLock } from "../core/driver-lock"
import { Orchestrator } from "../core/orchestrator"
import { FileStore } from "../core/store-file"
import type { MissionSummary, RoleIdentity, RoleName } from "../core/types"
import { WorktreeProvisioner, worktreeRoot } from "../core/worktree/provisioner"
import { ccCompletionForCursor } from "./cc-completions"
import {
	type ActivityState,
	type CommandCenterWidgetMode,
	commandCenterSkeleton,
	MISSIONS_WIDGET_KEY,
	type MissionWidgetRow,
	relatedMissions,
	renderCommandCenterWidget,
} from "./cc-missions-widget"
import {
	formatTerminalActivityTitle,
	formatTerminalTitle,
} from "./cc-terminal-status"

// Module-level state survives session switches (because the Node module stays in memory).
let orch: Orchestrator | null = null
/** The live session context, refreshed on every session_start (widget target). */
let widgetCtx: ExtensionContext | undefined
/** The extension API used to emit terminal-level mission activity signals. */
let extensionPi: ExtensionAPI | undefined
/** Base title before the terminal-level working marker is added. */
let terminalBaseTitle: string | undefined
/** Last title sent to the terminal, to avoid redundant OSC updates. */
let lastTerminalTitle: string | undefined
/** Mission activity is independent from the visible Pi agent turn state. */
let terminalMissionWorking = false

/** Update the terminal title without starting or keeping an LLM turn alive. */
function refreshTerminalActivityTitle(ctx: ExtensionContext): void {
	if (!ctx.hasUI || !extensionPi) return
	const baseTitle =
		terminalBaseTitle ??
		formatTerminalTitle(extensionPi.getSessionName(), ctx.cwd)
	const title = formatTerminalActivityTitle(baseTitle, terminalMissionWorking)
	if (title === lastTerminalTitle) return
	ctx.ui.setTitle(title)
	// Orca's visible tab title does not follow OSC 0; rename via the CLI.
	renameOrcaTabTitle(title)
	lastTerminalTitle = title
}

/** Set the mission-level activity signal consumed by terminal hosts. */
function setTerminalMissionActivity(
	ctx: ExtensionContext,
	working: boolean,
): void {
	terminalMissionWorking = working
	refreshTerminalActivityTitle(ctx)
}

type SessionInfoChangedEvent = {
	type: "session_info_changed"
	name: string | undefined
}

/** Throttle for delta-driven widget refreshes (stream chunks coalesce here). */
const WIDGET_REFRESH_MS = 200
let refreshTimer: ReturnType<typeof setTimeout> | undefined

/**
 * Poll interval for the pinned missions widget. Mission state lives in the
 * shared FileStore, so missions created/deleted by OTHER pi processes (other
 * sessions driving /cc) never emit orchestrator events here; a periodic poll
 * keeps the widget in sync with the store. Refreshes are cheap when nothing
 * changed (lastWidgetSkeleton skips the re-render), so the poll only costs a
 * store read per tick.
 */
const WIDGET_POLL_MS = 5000
let widgetPollTimer: ReturnType<typeof setInterval> | undefined

/** Start the periodic widget poll (idempotent; runs for the whole session). */
function startWidgetPolling(): void {
	if (widgetPollTimer) return
	widgetPollTimer = setInterval(() => {
		void refreshMissionsWidget().catch((error) => {
			console.error("Command Center widget poll failed:", error)
		})
	}, WIDGET_POLL_MS)
}

/** Stop the periodic widget poll (session teardown). */
function stopWidgetPolling(): void {
	if (widgetPollTimer) {
		clearInterval(widgetPollTimer)
		widgetPollTimer = undefined
	}
}

/** The last rendered table skeleton; an identical skeleton skips a re-render. */
let lastWidgetSkeleton: string | undefined
/** Live per-item activity, keyed by `<missionId>:<workItemId>`. */
const liveActivity = new Map<string, ActivityState>()

/** Whether the widget needs a render tick for an active activity spinner. */
function hasAnimatedActivity(mode: CommandCenterWidgetMode): boolean {
	return (
		mode.kind === "mission-lead" &&
		(mode.row.items ?? []).some((item) =>
			["starting", "thinking", "writing", "tool"].includes(
				item.activity?.phase ?? "",
			),
		)
	)
}

/** Missions parked because the visible session detached from their lead. */
const attachmentParkedMissions = new Set<string>()
let attachmentGateQueue: Promise<void> = Promise.resolve()
/**
 * Source-repo sessions to return to when detaching from a Mission Lead.
 * Session switches replace the visible session, but this module stays loaded,
 * so the mapping survives the `/cc new` → Mission Lead transition.
 */
const parentSessionByMission = new Map<string, string>()

function activityKey(missionId: string, workItemId: number): string {
	return `${missionId}:${workItemId}`
}

/** Coalesce refreshes: at most one pending, flushed WIDGET_REFRESH_MS later. */
function scheduleWidgetRefresh(): void {
	if (refreshTimer) return
	refreshTimer = setTimeout(() => {
		refreshTimer = undefined
		void refreshMissionsWidget()
	}, WIDGET_REFRESH_MS)
}

/**
 * Resolve the session thread file to attach to for a role, waiting (bounded)
 * for the orchestrator to acquire the role's session AND for its persisted
 * thread to appear on disk.
 *
 * Why wait for the thread FILE (not just the in-memory session): the pi SDK
 * writes a session's JSONL lazily — the runtime is "active" in memory as soon
 * as it's acquired, but the file is only flushed once the model turn starts
 * producing entries (observed ~3s after acquisition on a cold first turn).
 * `SessionManager.list` therefore returns [] for a session that IS live, and
 * attaching on the in-memory session alone fails with a spurious "No active
 * session found". Polling closes that window.
 *
 * Falls back to the role's most recent persisted thread when there is no live
 * in-memory session (engine restarted, or the mission parked idle) — same
 * semantics as the pre-existing attach path. Returns undefined only when
 * there is genuinely nothing to attach to (or the mission's repo is gone).
 */
async function resolveAttachTarget(
	orch: Orchestrator,
	missionId: string,
	roleName: RoleName,
	workItemId?: number,
	timeoutMs = 20000,
): Promise<{ path: string } | undefined> {
	// Resolve the role's worktree cwd. Attach is read-only and must work after a
	// process restart, so first register the mission's repo from the persisted
	// store (driving entry points register implicitly; a fresh process has none
	// registered). Unknown/deleted missions (not in the store) stay "no target".
	let cwd: string | undefined
	try {
		await orch.registerMission(missionId)
		cwd = orch.cwdFor({ missionId, roleName, workItemId })
	} catch {
		cwd = undefined
	}

	// Only poll for a live session when one is actually active in-memory: the
	// SDK flushes a session's thread file lazily (~3s after acquisition), so
	// attach must wait for it to appear. When no session is active (the common
	// attach-after-restart case) there is nothing to wait for — fall straight
	// through to the persisted-thread fallback below.
	const active = orch.getActiveSession(missionId, roleName, workItemId)
	if (active && cwd) {
		const deadline = Date.now() + timeoutMs
		for (;;) {
			const sessions = await SessionManager.list(cwd)
			const live = sessions.find((s) => s.id === active.sessionId)
			if (live) return { path: live.path }
			if (Date.now() >= deadline) break
			await new Promise((resolve) => setTimeout(resolve, 100))
		}
	}

	// No live session (or its thread never flushed): attach to the role's most
	// recent persisted thread instead. SessionManager.list returns sessions
	// newest-first by modified time.
	if (cwd) {
		const sessions = await SessionManager.list(cwd)
		const fallback = sessions[0]
		if (fallback) return { path: fallback.path }
	}
	return undefined
}

/** Switch the UI to a session thread file (shared by /cc attach and /cc new). */
async function attachToPath(
	ctx: ExtensionCommandContext,
	path: string,
	missionId: string,
	roleName: RoleName,
): Promise<boolean> {
	await ctx.ui.notify(
		`Switching focus to Mission ${missionId} Role ${roleName}...`,
		"info",
	)
	const result = await ctx.switchSession(path, {})
	if (result?.cancelled) {
		await ctx.ui.notify(`Session switch cancelled`, "error")
		return false
	}
	return true
}

/**
 * Switch the UI to a role's session (attach semantics shared by `/cc attach`
 * and the auto-attach after `/cc new`).
 */
async function attachToRole(
	ctx: ExtensionCommandContext,
	orch: Orchestrator,
	missionId: string,
	roleName: RoleName,
	workItemId?: number,
): Promise<boolean> {
	const mission = await orch.store.readMission(missionId)
	const sourceSessionFile =
		mission && normalizedPath(ctx.cwd) === normalizedPath(mission.repoPath)
			? ctx.sessionManager.getSessionFile()
			: undefined
	const target = await resolveAttachTarget(
		orch,
		missionId,
		roleName,
		workItemId,
	)
	if (!target) {
		await ctx.ui.notify(
			`No active session found for mission ${missionId} role ${roleName}`,
			"error",
		)
		return false
	}
	const attached = await attachToPath(ctx, target.path, missionId, roleName)
	if (!attached) return false
	if (sourceSessionFile) {
		parentSessionByMission.set(missionId, sourceSessionFile)
	}
	return true
}

/**
 * Return from a Mission Lead worktree to the source-repo session that was
 * visible when the mission was attached.
 */
async function detachToParentSession(
	ctx: ExtensionCommandContext,
	orch: Orchestrator,
): Promise<void> {
	const missions = await orch.store.listMissions()
	const mission = missions.find((candidate) =>
		isLeadAttachedToMission(candidate, ctx.cwd),
	)
	if (!mission) {
		await ctx.ui.notify(
			"You are not attached to a Mission Lead session.",
			"error",
		)
		return
	}

	const parentSessionFile = parentSessionByMission.get(mission.id)
	if (!parentSessionFile) {
		await ctx.ui.notify(
			`No original parent-repo session is known for mission ${mission.id}. Re-attach from the parent repo with /cc attach ${mission.id}.`,
			"error",
		)
		return
	}

	const result = await ctx.switchSession(parentSessionFile, {
		withSession: async (replacementCtx) => {
			await replacementCtx.ui.notify(
				`Returned to the parent-repo session for mission ${mission.id}`,
				"info",
			)
		},
	})
	if (result.cancelled) {
		await ctx.ui.notify("Session switch cancelled", "error")
	}
}

/**
 * The mission whose lead is attached to the current session — the gating check
 * for no-argument /cc launch and /cc resume. The cwd must be inside the
 * mission's integration worktree. Source-repo sessions and owner worktrees are
 * deliberately not drive-attached.
 */
async function requireAttachedLeadMission(
	ctx: ExtensionCommandContext,
	orch: Orchestrator,
): Promise<string | undefined> {
	const missions = await orch.store.listMissions()
	const mission = missions.find((m) => isLeadAttachedToMission(m, ctx.cwd))
	if (!mission) {
		await ctx.ui.notify(
			"You are not attached to a mission lead session. Run /cc attach <missionId> or switch to the mission's integration worktree.",
			"error",
		)
	}
	return mission?.id
}

function normalizedPath(p: string): string {
	return p // using simple string equality instead of path.resolve
}

/**
 * Resolve a visible session cwd to the exact Command Center role attached to
 * it. Only `integration` is considered the Mission Lead; source-repo sessions
 * and unknown worktree children are deliberately unattached.
 */
function visibleRoleForMission(
	mission: Pick<MissionSummary, "id" | "repoPath">,
	cwd: string,
): RoleIdentity | undefined {
	const cwdNorm = normalizedPath(cwd)
	const prefix = normalizedPath(
		`${worktreeRoot(mission.repoPath)}/${mission.id}`,
	)
	if (cwdNorm !== prefix && !cwdNorm.startsWith(`${prefix}/`)) return
	const relative = cwdNorm.substring(prefix.length).replace(/^\//, "")
	const [child] = relative.split("/")
	if (child === "integration") {
		return { missionId: mission.id, roleName: "mission_lead" }
	}
	if (child?.startsWith("work-")) {
		const rawWorkItemId = child.slice("work-".length)
		const workItemId = Number.parseInt(rawWorkItemId, 10)
		if (/^\d+$/.test(rawWorkItemId) && Number.isInteger(workItemId)) {
			return {
				missionId: mission.id,
				roleName: "work_item_owner",
				workItemId,
			}
		}
	}
	return undefined
}

function isLeadAttachedToMission(
	mission: Pick<MissionSummary, "id" | "repoPath">,
	cwd: string,
): boolean {
	return visibleRoleForMission(mission, cwd)?.roleName === "mission_lead"
}

async function currentVisibleRole(
	ctx: ExtensionContext,
): Promise<RoleIdentity | undefined> {
	if (!orch) return undefined
	const missions = await orch.store.listMissions()
	for (const mission of missions) {
		const role = visibleRoleForMission(mission, ctx.cwd)
		if (role) return role
	}
	return undefined
}

function queueAttachmentGate(ctx: ExtensionContext | undefined): void {
	attachmentGateQueue = attachmentGateQueue
		.then(() => evaluateDriveAttachment(ctx))
		.catch((error) => {
			console.error("Command Center attachment gate failed:", error)
		})
}

async function evaluateDriveAttachment(
	ctx: ExtensionContext | undefined,
): Promise<void> {
	if (!orch) return
	const missions = await orch.store.listMissions()
	const attachedLead = ctx
		? missions.find((mission) => isLeadAttachedToMission(mission, ctx.cwd))
		: undefined

	for (const mission of missions) {
		const lock = await orch.driverLock.status(mission.id)
		if (!lock.held || !lock.byMe) continue
		if (attachedLead?.id === mission.id) continue
		orch.parkMissionDrive(mission.id)
		attachmentParkedMissions.add(mission.id)
	}

	if (!attachedLead) return
	const driveWasParked =
		attachmentParkedMissions.has(attachedLead.id) ||
		orch.isMissionDriveParked(attachedLead.id)
	if (!driveWasParked) return
	const mission = await orch.store.readMission(attachedLead.id)
	if (mission?.status !== "in_progress") {
		attachmentParkedMissions.delete(attachedLead.id)
		return
	}
	const lock = await orch.driverLock.status(attachedLead.id)
	if (lock.held) {
		if (lock.byMe) {
			setTimeout(() => queueAttachmentGate(widgetCtx), 250)
		}
		return
	}
	attachmentParkedMissions.delete(attachedLead.id)
	void orch.resumeMission(attachedLead.id, { force: false }).catch((error) => {
		const err = error instanceof Error ? error : new Error(String(error))
		attachmentParkedMissions.add(attachedLead.id)
		void widgetCtx?.ui.notify(
			`Mission ${attachedLead.id} could not resume after re-attach: ${err.message}`,
			"error",
		)
	})
}

/**
 * Re-render the Command Center widget for the current session. A normal
 * session gets related missions; a Mission Lead session gets every work item
 * in its mission. Called on session_start, state events, and /cc commands.
 */
async function refreshMissionsWidget(): Promise<void> {
	const ctx = widgetCtx
	if (!ctx?.hasUI || !orch) return
	const missions = await orch.store.listMissions()
	const visibleRole = await currentVisibleRole(ctx)
	const driverLock = orch.driverLock
	const store = orch.store
	let mode: CommandCenterWidgetMode
	let terminalWorking = false

	if (visibleRole?.roleName === "mission_lead") {
		const mission = missions.find((item) => item.id === visibleRole.missionId)
		if (!mission) {
			setTerminalMissionActivity(ctx, false)
			if (lastWidgetSkeleton === undefined) return
			ctx.ui.setWidget(MISSIONS_WIDGET_KEY, undefined)
			lastWidgetSkeleton = undefined
			return
		}
		const plan = await store.readPlan(mission.id)
		const missionLock = await driverLock.status(mission.id)
		terminalWorking = mission.status === "in_progress" && missionLock.held
		mode = {
			kind: "mission-lead",
			row: {
				mission,
				sessionAttached: missionLock.held,
				items: (plan?.items ?? []).map((item) => ({
					id: item.id,
					title: item.title,
					status: item.status,
					activity: liveActivity.get(activityKey(mission.id, item.id)),
				})),
			},
		}
	} else {
		const related = relatedMissions(missions, ctx.cwd)
		if (related.length === 0) {
			setTerminalMissionActivity(ctx, false)
			// No missions for this repo — clear the widget. Skip the redundant call
			// when it is already cleared (poll ticks call this every 5s).
			if (lastWidgetSkeleton === undefined) return
			ctx.ui.setWidget(MISSIONS_WIDGET_KEY, undefined)
			lastWidgetSkeleton = undefined
			return
		}
		const rows: MissionWidgetRow[] = await Promise.all(
			related.map(async (mission) => {
				const missionLock = await driverLock.status(mission.id)
				return { mission, sessionAttached: missionLock.held }
			}),
		)
		mode = { kind: "normal", rows }
	}

	setTerminalMissionActivity(ctx, terminalWorking)

	// Delta streams keep scheduling refreshes, so avoid replacing the widget
	// unless its unstyled visible content actually changed.
	const skeleton = commandCenterSkeleton(mode)
	if (skeleton === lastWidgetSkeleton) return
	lastWidgetSkeleton = skeleton
	ctx.ui.setWidget(MISSIONS_WIDGET_KEY, (tui, theme) => {
		const fg = (color: ThemeColor, text: string) => theme.fg(color, text)
		let spinnerFrame = 0
		const animationTimer = hasAnimatedActivity(mode)
			? setInterval(() => {
					spinnerFrame += 1
					tui.requestRender()
				}, WIDGET_REFRESH_MS)
			: undefined
		return {
			render: (width) =>
				renderCommandCenterWidget(
					mode,
					fg,
					(text) => theme.bold(text),
					width,
					spinnerFrame,
				),
			invalidate: () => {},
			dispose: () => {
				if (animationTimer) clearInterval(animationTimer)
			},
		}
	})
}

import type { EmittableEvent } from "../core/events"

export interface IntercomExtensionOwner {
	sessionId: string
	epoch: string
}

export interface IntercomExtensionState {
	revision: number
	payload: unknown
}

export type IntercomExtensionEvent =
	| { type: "connection"; connected: boolean; supported: boolean }
	| { type: "owner"; owner?: IntercomExtensionOwner }
	| {
			type: "message"
			fromSessionId: string
			owner?: IntercomExtensionOwner
			payload: unknown
	  }
	| { type: "state"; state: IntercomExtensionState }
	| {
			type: "state_result"
			committed: boolean
			revision: number
			reason?: string
	  }
	| { type: "session_joined"; session: unknown }
	| { type: "session_left"; sessionId: string }
	| { type: "presence_update"; session: unknown }

export interface IntercomExtensionChannel {
	readonly namespace: string
	snapshot(): {
		connected: boolean
		supported: boolean
		owner?: IntercomExtensionOwner
		state?: IntercomExtensionState
	}
	publish(
		payload: unknown,
		options?: { audience?: "owner" | "capable"; ownerOnly?: boolean },
	): void
	commitState(payload: unknown, expectedRevision?: number): void
	listSessions(): Promise<unknown[]>
}

export interface IntercomExtensionRegistration {
	namespace: string
	ownerEligible: boolean
	onEvent(event: IntercomExtensionEvent): void
	onReady(channel: IntercomExtensionChannel): void
}

export default function (pi: ExtensionAPI) {
	let intercomChannel: IntercomExtensionChannel | undefined
	let hasWarnedAboutIntercom = false
	// Set when pi-intercom confirms the registration via onReady — proof that a
	// registration actually landed (vs. an emit that no listener received).
	let intercomRegistered = false

	const registration: IntercomExtensionRegistration = {
		namespace: "command-center",
		ownerEligible: false,
		onEvent: (event) => {
			if (event.type === "message" && orch) {
				const normalized = event.payload as EmittableEvent
				orch.bus.emit(normalized)
			}
		},
		onReady: (channel) => {
			intercomChannel = channel
			intercomRegistered = true
		},
	}
	// Load-order robustness: pi-intercom only listens for registrations after
	// its own factory runs, and this bundle is typically listed BEFORE
	// npm:pi-intercom in settings packages — a bare factory-time emit fires
	// before any listener exists and is silently lost, so the channel never
	// becomes ready and /cc warns "requires pi-intercom" even though it is
	// installed. pi-intercom announces "intercom:extension-registry-ready" once
	// its registry is live; re-register then. onReady arms the guard, so a lost
	// emit retries on the announcement and a landed one never duplicates.
	const registerIntercom = (): void => {
		if (intercomRegistered) return
		pi.events.emit("intercom:extension-register", registration)
	}
	registerIntercom()
	pi.events.on("intercom:extension-registry-ready", registerIntercom)
	extensionPi = pi

	// `session_info_changed` is available in the runtime even when older SDK
	// typings do not include it. Track the base title so the mission marker does
	// not erase titles set by /name or the auto-title extension.
	// SAFETY: the runtime emits `session_info_changed` events whose payload
	// matches SessionInfoChangedEvent; the cast only widens `pi.on` for an
	// event the installed SDK typings do not model.
	const onSessionInfoChanged = pi.on as unknown as (
		event: "session_info_changed",
		handler: (event: SessionInfoChangedEvent, ctx: ExtensionContext) => void,
	) => void
	onSessionInfoChanged("session_info_changed", (event, ctx) => {
		terminalBaseTitle = formatTerminalTitle(event.name, ctx.cwd)
		lastTerminalTitle = undefined
		refreshTerminalActivityTitle(ctx)
	})

	pi.on("session_start", async (_event, ctx) => {
		terminalBaseTitle = formatTerminalTitle(pi.getSessionName(), ctx.cwd)
		lastTerminalTitle = undefined
		terminalMissionWorking = false
		refreshTerminalActivityTitle(ctx)

		if (!orch) {
			const store = new FileStore()
			orch = new Orchestrator({
				sessionRunner: (bus, store) =>
					createAutoSessionRunner({
						bus,
						store,
						pi,
						getContext: () => widgetCtx,
						resolveVisibleRole: currentVisibleRole,
					}),
				worktreeProvider: new WorktreeProvisioner(),
				store,
				// Cross-process coordination: exactly one process may drive a
				// mission at a time. Explicit /cc commands force-takeover.
				driverLock: new FileDriverLock(),
				canDriveMission: async (missionId) => {
					const ctx = widgetCtx
					if (!ctx) return false
					const mission = await store.readMission(missionId)
					return mission ? isLeadAttachedToMission(mission, ctx.cwd) : false
				},
			})

			orch.subscribeAll((e) => {
				if (
					e.type === "mission-status-changed" ||
					e.type === "work-item-status-changed" ||
					e.type === "mission-defined" ||
					e.type === "mission-deleted"
				) {
					ctx.ui.notify(
						`[Command Center] ${e.type} (Mission ${e.missionId})`,
						"info",
					)
				}
				// Live per-item activity for the pinned widget. Owner events carry
				// workItemId; lead events don't map to an item row. `session-ended`
				// is a turn boundary in the normalized event vocabulary, not proof
				// that the owner session was parked, so keep it in a waiting state.
				if (e.type === "session-started" && e.workItemId !== undefined) {
					liveActivity.set(activityKey(e.missionId, e.workItemId), {
						phase: "starting",
					})
					scheduleWidgetRefresh()
				} else if (e.type === "reasoning-delta" && e.workItemId !== undefined) {
					liveActivity.set(activityKey(e.missionId, e.workItemId), {
						phase: "thinking",
					})
					scheduleWidgetRefresh()
				} else if (e.type === "message-delta" && e.workItemId !== undefined) {
					liveActivity.set(activityKey(e.missionId, e.workItemId), {
						phase: "writing",
					})
					scheduleWidgetRefresh()
				} else if (
					e.type === "tool-call-started" &&
					e.workItemId !== undefined
				) {
					liveActivity.set(activityKey(e.missionId, e.workItemId), {
						phase: "tool",
						tool: e.toolName,
					})
					scheduleWidgetRefresh()
				} else if (
					(e.type === "tool-call-ended" ||
						e.type === "message-ended" ||
						e.type === "session-ended") &&
					e.workItemId !== undefined
				) {
					liveActivity.set(activityKey(e.missionId, e.workItemId), {
						phase: "waiting",
					})
					scheduleWidgetRefresh()
				} else if (e.type === "help-requested" && e.workItemId !== undefined) {
					liveActivity.set(activityKey(e.missionId, e.workItemId), {
						phase: "needs_help",
					})
					scheduleWidgetRefresh()
				} else if (e.type === "help-responded" && e.workItemId !== undefined) {
					liveActivity.set(activityKey(e.missionId, e.workItemId), {
						phase: "starting",
					})
					scheduleWidgetRefresh()
				} else if (e.type === "work-item-status-changed") {
					liveActivity.delete(activityKey(e.missionId, e.workItemId))
				} else if (e.type === "mission-deleted") {
					attachmentParkedMissions.delete(e.missionId)
					for (const key of [...liveActivity.keys()]) {
						if (key.startsWith(`${e.missionId}:`)) liveActivity.delete(key)
					}
				}

				// Keep the pinned missions list in sync with mission/plan state.
				if (
					e.type === "mission-status-changed" ||
					e.type === "work-item-status-changed" ||
					e.type === "mission-defined" ||
					e.type === "plan-written" ||
					e.type === "mission-deleted"
				) {
					void refreshMissionsWidget()
				}
			})

			// NO auto-resume: missions are driven only by explicit /cc commands
			// (new / launch / resume / accept / reject / abort / delete), each of
			// which acquires the mission's driver lock.
		}

		// The widget targets the CURRENT session: refresh the context on every
		// session_start (new/resume/fork/reload can change the cwd). Reset the
		// skeleton so the widget is always (re)built for the new session.
		widgetCtx = ctx
		lastWidgetSkeleton = undefined
		startWidgetPolling()
		queueAttachmentGate(ctx)
		await refreshMissionsWidget()

		// Bind the Mission Lead to the visible session when the UI lands in a
		// PENDING mission's integration worktree. This is the reliable place for
		// it: pi re-loads the extension when a session switch changes cwd (its
		// extension module cache is cwd-keyed), so /cc new's own
		// bindVisibleLead call — made on the PREVIOUS module instance — sees a
		// widgetCtx reset by the old session's shutdown and a stale pi, and can
		// never register the lead's domain tools on the new session. Here, on
		// the NEW instance, widgetCtx points at the just-switched session and
		// pi.registerTool targets the live extension runtime. Runs for any
		// entry into a pending lead worktree: /cc new, /cc attach, and a
		// restart while already attached.
		const visibleRole = await currentVisibleRole(ctx)
		if (visibleRole?.roleName === "mission_lead") {
			await orch.bindVisibleLead(visibleRole.missionId)
		} else if (visibleRole?.roleName === "work_item_owner") {
			const { createDomainTools } = await import("../core/tools/tool_factory")
			const mission = await orch.store.readMission(visibleRole.missionId)
			if (mission) {
				const tools = createDomainTools(
					{
						who: visibleRole,
						repoPath: mission.repoPath,
						cwd: ctx.cwd,
						store: orch.store,
						bus: orch.bus,
					},
					["update_memory", "request_review", "request_help"],
				)
				for (const tool of tools) {
					pi.registerTool(tool)
				}
			}
		}

		// /cc argument completions via a wrapper around the built-in provider.
		// The built-in slash-command provider replaces the WHOLE argument text
		// with the completed value (Tab on `/cc attach ` yields `/cc some-id`),
		// so mission-id completions must come from here with `prefix` set to just
		// the id token — applyCompletion then swaps only that token.
		ctx.ui.addAutocompleteProvider((current) => ({
			async getSuggestions(lines, cursorLine, cursorCol, options) {
				const beforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol)
				const missions = orch ? await orch.store.listMissions() : []
				const completion = ccCompletionForCursor(beforeCursor, missions)
				if (completion) return completion
				return current.getSuggestions(lines, cursorLine, cursorCol, options)
			},
			applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
				return current.applyCompletion(
					lines,
					cursorLine,
					cursorCol,
					item,
					prefix,
				)
			},
			shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
				return (
					current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ??
					true
				)
			},
		}))
	})

	const onRawSessionEvent = pi.on.bind(pi) as (
		event: string,
		handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>,
	) => void

	onRawSessionEvent("tool_execution_end", async (event, ctx) => {
		const visibleRole = await currentVisibleRole(ctx)
		if (visibleRole?.roleName === "work_item_owner") {
			const raw = event as AgentSessionEvent
			if (
				raw.type === "tool_execution_end" &&
				(raw.toolName === "request_review" || raw.toolName === "request_help")
			) {
				const { normalizePiEvent } = await import("../core/session")
				const normalized = normalizePiEvent(
					visibleRole,
					ctx.sessionManager.getSessionId(),
					raw,
				)
				if (normalized && intercomChannel) {
					intercomChannel.publish(normalized, { audience: "capable" })
				}
			}
		}
	})

	pi.on("session_before_switch", () => {
		queueAttachmentGate(undefined)
	})

	pi.on("session_shutdown", (_event, ctx) => {
		stopWidgetPolling()
		queueAttachmentGate(undefined)
		terminalMissionWorking = false
		refreshTerminalActivityTitle(ctx)
		terminalBaseTitle = undefined
		lastTerminalTitle = undefined
		// The runner clears extension widgets on teardown; dropping the context
		// stops background-drive events from touching a torn-down UI. The next
		// session_start re-establishes it.
		widgetCtx = undefined
	})

	pi.registerCommand("cc", {
		description: "Command Center: /cc <command>",
		handler: async (args, ctx) => {
			if (!orch) return

			if (
				(isHerdrEnv() || isOrcaEnv()) &&
				!intercomChannel &&
				!hasWarnedAboutIntercom
			) {
				await ctx.ui.notify(
					"Command Center in Herdr or Orca requires the 'pi-intercom' package for cross-pane communication. Please run: pi install npm:pi-intercom",
					"warning",
				)
				hasWarnedAboutIntercom = true
			}

			const argsList = args.trim().split(" ")
			const cmd = argsList[0]

			if (cmd === "list") {
				const missions = await orch.store.listMissions()
				if (missions.length === 0) {
					await ctx.ui.notify("No missions found.", "info")
					return
				}
				const msg = missions
					.map((m) => `- ${m.id} | ${m.status.padEnd(20)} | ${m.title}`)
					.join("\n")
				// TODO: we can't do plain logging, we must output to UI
				// actually we can use ctx.ui.notify or add a system message
				await ctx.ui.notify(msg, "info")
			} else if (cmd === "new") {
				// /cc new — create a mission stub + integration worktree and open
				// the Mission Lead's session in it, then switch to that session:
				// the human works with the lead interactively to define the
				// mission and write the plan. No drive starts; execution begins
				// only on /cc launch.
				const missionId = await orch.createMission({ repoPath: ctx.cwd })
				await ctx.ui.notify(
					`Mission ${missionId} created — define it with the Mission Lead`,
					"info",
				)
				// Switch to the lead's session. The lead's thread file is written
				// lazily (only once its opening turn flushes entries), so
				// resolveAttachTarget waits for it rather than attaching to an
				// in-memory-only session. The lead's domain tools are bound by the
				// new session's session_start (see the auto-bind there): the switch
				// reloads the extension for the worktree cwd, and only that fresh
				// module instance can register tools on the live visible session.
				await attachToRole(ctx, orch, missionId, "mission_lead")
			} else if (cmd === "launch") {
				// /cc launch — start the mission whose lead session is visible
				// (pending → in_progress, then drive its plan in the background).
				// Drive ownership is gated on staying attached to the lead.
				const missionId = await requireAttachedLeadMission(ctx, orch)
				if (!missionId) return
				try {
					await orch.launchMission(missionId, {
						onDriveError: (id, error) => {
							ctx.ui.notify(
								`Mission ${id} failed to drive: ${error.message}`,
								"error",
							)
						},
					})
					await ctx.ui.notify(`Launched mission ${missionId}`, "info")
				} catch (error) {
					const err = error instanceof Error ? error : new Error(String(error))
					await ctx.ui.notify(err.message, "error")
				}
			} else if (cmd === "abort") {
				const missionId = argsList[1]
				const workItemId = argsList[2]
				if (!missionId) {
					await ctx.ui.notify(
						"Usage: /cc abort <missionId> [workItemId]",
						"error",
					)
					return
				}
				if (workItemId) {
					await orch.abortWorkItem(missionId, parseInt(workItemId, 10))
					await ctx.ui.notify(
						`Aborted work item ${workItemId} on mission ${missionId}`,
						"info",
					)
				} else {
					await orch.abortMission(missionId)
					await ctx.ui.notify(`Aborted mission ${missionId}`, "info")
				}
			} else if (cmd === "delete") {
				// /cc delete <missionId>
				// Removes ~/.command-center state, worktrees and git branches.
				const missionId = argsList[1]
				if (!missionId) {
					await ctx.ui.notify("Usage: /cc delete <missionId>", "error")
					return
				}
				await orch.deleteMission(missionId)
				await ctx.ui.notify(`Deleted mission ${missionId}`, "info")
			} else if (cmd === "attach") {
				// /cc attach <missionId> — only Mission Lead sessions are visible.
				// Work Item Owner sessions remain hidden from the human UI.
				const missionId = argsList[1]
				if (argsList[2]) {
					await ctx.ui.notify(
						"Attaching to Work Item Owner sessions is not supported; attach to the Mission Lead instead.",
						"error",
					)
					return
				}

				if (!missionId) {
					await ctx.ui.notify("Usage: /cc attach <missionId>", "error")
					return
				}

				const roleName: RoleName = "mission_lead"

				// Multi-process guard: attaching to a mission another live
				// process is driving would race concurrent writers on the role's
				// session thread. Attach there, or take over the drive first.
				const lock = await orch.driverLock.status(missionId)
				if (lock.held && !lock.byMe) {
					await ctx.ui.notify(
						`Mission ${missionId} is driven by pid ${lock.holder?.pid} in another process. Attach there, or run /cc resume to take over first.`,
						"error",
					)
					return
				}

				// The pending lead's domain tools are bound by the new session's
				// session_start (see the auto-bind there). Owners stay on hidden
				// sessions; in_progress missions are driven and already bind on
				// attach — bindVisibleLead no-ops for those anyway.
				await attachToRole(ctx, orch, missionId, roleName)
			} else if (cmd === "detach") {
				// /cc detach — return to the source-repo session saved when this
				// mission was attached.
				if (argsList[1]) {
					await ctx.ui.notify("Usage: /cc detach", "error")
					return
				}
				await detachToParentSession(ctx, orch)
				return
			} else if (cmd === "resume") {
				// /cc resume — re-drive the mission whose lead session is visible.
				// Explicit takeover: force-acquires the driver lock; a displaced
				// driver in another process stops at its next loop iteration. Only
				// allowed from the mission's integration worktree, and only for an
				// already-launched (in_progress) mission.
				const missionId = await requireAttachedLeadMission(ctx, orch)
				if (!missionId) return
				const mission = await orch.store.readMission(missionId)
				if (mission?.status !== "in_progress") {
					await ctx.ui.notify(
						`Mission ${missionId} is ${mission?.status ?? "unknown"}, not in_progress. Use /cc launch to start it.`,
						"error",
					)
					return
				}
				const tookOverFrom = await orch.resumeMission(missionId)
				await ctx.ui.notify(
					tookOverFrom
						? `Resumed mission ${missionId} (took over from pid ${tookOverFrom.pid})`
						: `Resumed mission ${missionId}`,
					"info",
				)
			} else if (cmd === "accept") {
				const missionId = argsList[1]
				if (!missionId) {
					await ctx.ui.notify("Usage: /cc accept <missionId>", "error")
					return
				}
				await orch.reviewMission(missionId, "accept")
				await ctx.ui.notify(`Accepted mission ${missionId}`, "info")
			} else if (cmd === "reject") {
				const missionId = argsList[1]
				const feedback = argsList.slice(2).join(" ")
				if (!missionId || !feedback) {
					await ctx.ui.notify(
						"Usage: /cc reject <missionId> <feedback>",
						"error",
					)
					return
				}
				await orch.reviewMission(missionId, "reject", feedback)
				await ctx.ui.notify(`Rejected mission ${missionId}`, "info")
			} else {
				await ctx.ui.notify(`Unknown command: /cc ${cmd}`, "error")
			}

			// Mission state may have changed (new/launch/delete/abort/accept/…). The
			// orchestrator emits events for background drives, but /cc new's
			// stub write emits none — refresh unconditionally.
			void refreshMissionsWidget()
		},
	})
}
