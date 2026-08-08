import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent"
import { SessionManager } from "@earendil-works/pi-coding-agent"
import { FileDriverLock } from "../core/driver-lock"
import { Orchestrator } from "../core/orchestrator"
import { PiSessionRunner } from "../core/session"
import { FileStore } from "../core/store-file"
import type { RoleName } from "../core/types"
import { WorktreeProvisioner } from "../core/worktree/provisioner"
import { ccCompletionForCursor } from "./cc-completions"

// Module-level state survives session switches (because the Node module stays in memory).
let orch: Orchestrator | null = null

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
	// Resolve the role's worktree cwd. cwdFor throws when the mission's repo
	// isn't registered (terminal/deleted mission) — surface as a clean error
	// rather than an unhandled rejection.
	let cwd: string | undefined
	try {
		cwd = orch.cwdFor({ missionId, roleName, workItemId })
	} catch {
		cwd = undefined
	}

	const sessions = cwd ? await SessionManager.list(cwd) : []
	const active = orch.getActiveSession(missionId, roleName, workItemId)
	let targetSessionInfo = active
		? sessions.find((s) => s.id === active.sessionId)
		: undefined
	if (!targetSessionInfo && sessions.length > 0) {
		// No live in-memory session (engine restarted, or the mission is
		// parked idle and the orchestrator isn't holding the role's session):
		// attach to the role's most recent persisted thread instead.
		// SessionManager.list returns sessions newest-first by modified time.
		targetSessionInfo = sessions[0]
	}

	if (!targetSessionInfo) {
		await ctx.ui.notify(
			`No active session found for mission ${missionId} role ${roleName}`,
			"error",
		)
		return
	}

	await ctx.ui.notify(
		`Switching focus to Mission ${missionId} Role ${roleName}...`,
		"info",
	)
	const result = await ctx.switchSession(targetSessionInfo.path, {})
	if (result?.cancelled) {
		await ctx.ui.notify(`Session switch cancelled`, "error")
	}
}

/**
 * Wait (bounded) for the orchestrator to acquire a role's session. Returns
 * once the session exists or `timeoutMs` elapses — the caller's persisted-
 * session fallback in attachToRole covers the timeout case.
 */
async function waitForRoleSession(
	orch: Orchestrator,
	missionId: string,
	roleName: RoleName,
	workItemId?: number,
	timeoutMs = 20000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (orch.getActiveSession(missionId, roleName, workItemId)) return
		await new Promise((resolve) => setTimeout(resolve, 100))
	}
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
			})

			// NO auto-resume: missions are driven only by explicit /cc commands
			// (start / resume / reply / accept / reject / abort / delete), each
			// of which acquires the mission's driver lock.
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
				// orchestrator drives the lead in the background.
				const missionId = await orch.queueMission(description, { repoPath })
				await ctx.ui.notify(`Started mission ${missionId}`, "info")
				// Automatically switch to the new mission's lead session.
				await waitForRoleSession(orch, missionId, "mission_lead")
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
		},
	})
}
