import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ThemeColor,
} from "@earendil-works/pi-coding-agent"
import {
	getMarkdownTheme,
	SessionManager,
} from "@earendil-works/pi-coding-agent"
import { Markdown } from "@earendil-works/pi-tui"
import { FileDriverLock } from "../core/driver-lock"
import { Orchestrator } from "../core/orchestrator"
import { PiSessionRunner } from "../core/session"
import { FileStore } from "../core/store-file"
import type { RoleName } from "../core/types"
import { WorktreeProvisioner } from "../core/worktree/provisioner"
import { ccCompletionForCursor } from "./cc-completions"
import {
	type ActivityState,
	buildMissionsMarkdown,
	isInsideMissionWorktrees,
	MISSIONS_WIDGET_KEY,
	type MissionWidgetRow,
	missionsHeader,
	relatedMissions,
	stripTableBorders,
} from "./cc-missions-widget"

// Module-level state survives session switches (because the Node module stays in memory).
let orch: Orchestrator | null = null
/** The live session context, refreshed on every session_start (widget target). */
let widgetCtx: ExtensionContext | undefined

/** Throttle for delta-driven widget refreshes (stream chunks coalesce here). */
const WIDGET_REFRESH_MS = 200
let refreshTimer: ReturnType<typeof setTimeout> | undefined
/** The last rendered table skeleton; an identical skeleton skips a re-render. */
let lastWidgetSkeleton: string | undefined
/** Live per-item activity, keyed by `<missionId>:<workItemId>`. */
const liveActivity = new Map<string, ActivityState>()

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

/** Switch the UI to a session thread file (shared by /cc attach and /cc start). */
async function attachToPath(
	ctx: ExtensionCommandContext,
	path: string,
	missionId: string,
	roleName: RoleName,
): Promise<void> {
	await ctx.ui.notify(
		`Switching focus to Mission ${missionId} Role ${roleName}...`,
		"info",
	)
	const result = await ctx.switchSession(path, {})
	if (result?.cancelled) {
		await ctx.ui.notify(`Session switch cancelled`, "error")
	}
}

/**
 * Switch the UI to a role's session (attach semantics shared by `/cc attach`
 * and the auto-attach after `/cc start`).
 */
async function attachToRole(
	ctx: ExtensionCommandContext,
	orch: Orchestrator,
	missionId: string,
	roleName: RoleName,
	workItemId?: number,
): Promise<void> {
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
		return
	}
	await attachToPath(ctx, target.path, missionId, roleName)
}

/**
 * Re-render the missions pinned above the input editor for the current
 * session. Missions whose repo source path equals the session's cwd are
 * shown; an empty list clears the widget. Called on session_start, on
 * orchestrator events that change mission state, and after every /cc command.
 */
async function refreshMissionsWidget(): Promise<void> {
	const ctx = widgetCtx
	if (!ctx?.hasUI || !orch) return
	const missions = await orch.store.listMissions()
	const related = relatedMissions(missions, ctx.cwd)
	if (related.length === 0) {
		ctx.ui.setWidget(MISSIONS_WIDGET_KEY, undefined)
		lastWidgetSkeleton = undefined
		return
	}
	// "Session attached" = a live process holds the mission's driver lock
	// (a pi session is currently driving the mission). Items come from the
	// persisted plan; live activity comes from the forwarded session events.
	// A mission's task list is expanded only when the current session is
	// attached to it (cwd inside its worktrees dir); otherwise missions show
	// as single rows.
	const driverLock = orch.driverLock
	const store = orch.store
	const rows: MissionWidgetRow[] = await Promise.all(
		related.map(async (mission) => {
			const sessionAttached = (await driverLock.status(mission.id)).held
			if (!isInsideMissionWorktrees(mission, ctx.cwd)) {
				return { mission, sessionAttached }
			}
			const plan = await store.readPlan(mission.id)
			return {
				mission,
				sessionAttached,
				items: (plan?.items ?? []).map((item) => ({
					id: item.id,
					title: item.title,
					status: item.status,
					activity: liveActivity.get(activityKey(mission.id, item.id)),
				})),
			}
		}),
	)
	// Skip the re-render when nothing visible changed — delta streams keep
	// scheduling refreshes but rarely change the table (only phase/tool do).
	const skeleton = buildMissionsMarkdown(rows)
	if (skeleton === lastWidgetSkeleton) return
	lastWidgetSkeleton = skeleton
	// Render the missions as a markdown table: the Markdown component owns the
	// column sizing, cell wrapping and narrow-width fallback. Strip the
	// table's horizontal borders, header and outer walls, indent the rows,
	// and prepend the mini-task-style Command Center header line.
	ctx.ui.setWidget(MISSIONS_WIDGET_KEY, (_tui, theme) => {
		const fg = (color: ThemeColor, text: string) => theme.fg(color, text)
		const markdown = buildMissionsMarkdown(rows, fg)
		const md = new Markdown(markdown, 0, 0, getMarkdownTheme())
		return {
			render: (width) => [
				missionsHeader(rows, fg, (text) => theme.bold(text), width),
				...stripTableBorders(md.render(width)).map((line) =>
					// Rows sit under the header with a left indent.
					line ? `  ${line}` : line,
				),
			],
			invalidate: () => md.invalidate(),
		}
	})
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (!orch) {
			const store = new FileStore()
			orch = new Orchestrator({
				sessionRunner: (bus, store) => new PiSessionRunner({ bus, store }),
				worktreeProvider: new WorktreeProvisioner(),
				store,
				// Cross-process coordination: exactly one process may drive a
				// mission at a time. Explicit /cc commands force-takeover.
				driverLock: new FileDriverLock(),
			})

			orch.subscribeAll((e) => {
				if (e.type === "human-input-requested") {
					ctx.ui.notify(
						`Action needed for Mission ${e.missionId}: ${e.question}`,
						"info",
					)
				} else if (
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
				// workItemId; lead events don't map to an item row.
				if (e.type === "reasoning-delta" && e.workItemId !== undefined) {
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
					(e.type === "tool-call-ended" || e.type === "session-ended") &&
					e.workItemId !== undefined
				) {
					liveActivity.set(activityKey(e.missionId, e.workItemId), {
						phase: "idle",
					})
					scheduleWidgetRefresh()
				} else if (e.type === "work-item-status-changed") {
					liveActivity.delete(activityKey(e.missionId, e.workItemId))
				} else if (e.type === "mission-deleted") {
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
			// (start / resume / reply / accept / reject / abort / delete), each
			// of which acquires the mission's driver lock.
		}

		// The widget targets the CURRENT session: refresh the context on every
		// session_start (new/resume/fork/reload can change the cwd). Reset the
		// skeleton so the widget is always (re)built for the new session.
		widgetCtx = ctx
		lastWidgetSkeleton = undefined
		await refreshMissionsWidget()

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

	pi.on("session_shutdown", () => {
		// The runner clears extension widgets on teardown; dropping the context
		// stops background-drive events from touching a torn-down UI. The next
		// session_start re-establishes it.
		widgetCtx = undefined
	})

	pi.registerCommand("cc", {
		description: "Command Center: /cc <command>",
		handler: async (args, ctx) => {
			if (!orch) return
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
			} else if (cmd === "start") {
				// /cc start <description>
				const repoPath = ctx.cwd // the extension runs in the main workspace
				const description = argsList.slice(1).join(" ")
				if (!description) {
					await ctx.ui.notify("Usage: /cc start <description>", "error")
					return
				}
				// Queue the mission so the command returns immediately; the
				// orchestrator drives the lead in the background. A failed drive
				// (session creation / worktree / model errors) surfaces via
				// onDriveError — otherwise it'd read as a confusing
				// "No active session found" later.
				const missionId = await orch.queueMission(description, {
					repoPath,
					onDriveError: (id, error) => {
						ctx.ui.notify(
							`Mission ${id} failed to start: ${error.message}`,
							"error",
						)
					},
				})
				await ctx.ui.notify(`Started mission ${missionId}`, "info")
				// Automatically switch to the new mission's lead session. The
				// lead's thread file is written lazily (only once its first model
				// turn flushes entries), so resolveAttachTarget waits for it
				// rather than attaching to an in-memory-only session.
				await attachToRole(ctx, orch, missionId, "mission_lead")
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
				// /cc attach <missionId> [workItemId]
				// Attaches to the mission lead; with a work item id, the item's owner.
				const missionId = argsList[1]
				const workItemId = argsList[2] ? parseInt(argsList[2], 10) : undefined

				if (!missionId) {
					await ctx.ui.notify(
						"Usage: /cc attach <missionId> [workItemId]",
						"error",
					)
					return
				}

				const roleName: RoleName =
					workItemId !== undefined ? "work_item_owner" : "mission_lead"

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

				await attachToRole(ctx, orch, missionId, roleName, workItemId)
			} else if (cmd === "resume") {
				const targetMissionId = argsList[1]
				if (!targetMissionId) {
					await ctx.ui.notify("Usage: /cc resume <missionId>", "error")
					return
				}
				// Explicit takeover: force-acquires the driver lock; a displaced
				// driver in another process stops at its next loop iteration.
				const tookOverFrom = await orch.resumeMission(targetMissionId)
				await ctx.ui.notify(
					tookOverFrom
						? `Resumed mission ${targetMissionId} (took over from pid ${tookOverFrom.pid})`
						: `Resumed mission ${targetMissionId}`,
					"info",
				)
			} else if (cmd === "reply") {
				const missionId = argsList[1]
				const requestId = argsList[2]
				const message = argsList.slice(3).join(" ")
				if (!missionId || !requestId || !message) {
					await ctx.ui.notify(
						"Usage: /cc reply <missionId> <requestId> <message>",
						"error",
					)
					return
				}
				await orch.replyHumanInput(missionId, requestId, message)
				await ctx.ui.notify(`Replied to human input ${requestId}`, "info")
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

			// Mission state may have changed (start/delete/abort/accept/…). The
			// orchestrator emits events for background drives, but /cc start's
			// stub write emits none — refresh unconditionally.
			void refreshMissionsWidget()
		},
	})
}
