import path from "node:path"
import type { ThemeColor } from "@earendil-works/pi-coding-agent"
import { truncateToWidth } from "@earendil-works/pi-tui"
import type {
	MissionStatus,
	MissionSummary,
	WorkItemStatus,
} from "../core/types"
import { worktreeRoot } from "../core/worktree/provisioner"

// ---------------------------------------------------------------------------
// Missions pinned above the input editor
//
// While a session runs in a repo, the Command Center pins every mission whose
// repo source path equals the session's cwd above the input editor, so the
// missions that own this checkout stay visible without /cc list.
//
// The widget has two views: a normal repo view with one compact row per
// related mission, and a Mission Lead view with one row per work item. The
// renderers below are pure so cc.ts only has to select the view from the
// visible session's role and supply the current persisted/live data.
// ---------------------------------------------------------------------------

/** Widget key used with ctx.ui.setWidget — the pinned missions list. */
export const MISSIONS_WIDGET_KEY = "cc-missions"

/** Title shown in the widget header. */
export const MISSIONS_WIDGET_TITLE = "Command Center"

/** Cap the number of visible widget rows before a "+N more" line. */
export const MAX_WIDGET_LINES = 20

/** Cap a single title's length so a pathological title can't balloon the widget. */
export const MAX_TITLE_CHARS = 120

export const HEADER_LEFT_PADDING = " "
export const ROW_LEFT_PADDING = "  "

/** Live per-role activity for a work item, driven by forwarded session events. */
export type ActivityPhase =
	| "starting"
	| "thinking"
	| "writing"
	| "tool"
	| "waiting"
	| "needs_help"
	| "idle"

export interface ActivityState {
	phase: ActivityPhase
	/** The tool name while `phase === "tool"`. */
	tool?: string
}

/** A work item row in the Mission Lead widget. */
export interface WorkItemWidgetRow {
	id: number
	title: string
	status: WorkItemStatus
	/** The owner's live activity (absent when idle or the session is parked). */
	activity?: ActivityState
}

/** A mission row in the widget: the mission plus its live-driver state. */
export interface MissionWidgetRow {
	mission: MissionSummary
	/** True when a live process holds the mission's driver lock (session attached). */
	sessionAttached: boolean
	/** The mission's plan items (persisted status + live activity), when planned. */
	items?: WorkItemWidgetRow[]
}

/** Widget ordering: active missions first, terminal missions last. */
const STATUS_ORDER: Record<MissionStatus, number> = {
	in_progress: 0,
	ready_for_acceptance: 1,
	pending: 2,
	completed: 3,
	cancelled: 4,
}

/** Readable, title-cased status labels for display. */
const STATUS_LABEL: Record<MissionStatus, string> = {
	pending: "Pending",
	in_progress: "In progress",
	ready_for_acceptance: "Ready for acceptance",
	completed: "Completed",
	cancelled: "Cancelled",
}

/** Per-status display color for missions and work-item fallback states. */
const STATUS_COLOR: Record<MissionStatus | WorkItemStatus, ThemeColor> = {
	pending: "muted",
	in_progress: "accent",
	ready_for_acceptance: "warning",
	ready_for_review: "warning",
	accepted: "success",
	completed: "success",
	cancelled: "error",
}

/** Color for each live activity category. */
const ACTIVITY_COLOR: Record<ActivityPhase, ThemeColor> = {
	starting: "accent",
	thinking: "accent",
	writing: "accent",
	tool: "warning",
	waiting: "accent",
	needs_help: "error",
	idle: "dim",
}

/** Fixed-width ASCII frames keep activity rows aligned in every terminal. */
const SPINNER_FRAMES = ["-", "\\", "|", "/"] as const

/**
 * Absolute, normalized form of a path for comparison. Handles trailing
 * slashes and `..`; relative paths resolve against the process cwd.
 */
function normalizePath(p: string): string {
	return path.resolve(p)
}

/**
 * The normalized prefix of a mission's worktrees dir:
 * `$HOME/.command-center/worktrees/<missionId>`. A role session running
 * there (lead = integration, owner = work-N) is attached to the mission.
 */
function missionWorktreesPrefix(mission: {
	repoPath: string
	id: string
}): string {
	return normalizePath(path.join(worktreeRoot(mission.repoPath), mission.id))
}

/** True when a session cwd is inside this mission's worktrees dir. */
export function isInsideMissionWorktrees(
	mission: { repoPath: string; id: string },
	cwd: string,
): boolean {
	const cwdNorm = normalizePath(cwd)
	const prefix = missionWorktreesPrefix(mission)
	return cwdNorm === prefix || cwdNorm.startsWith(prefix + path.sep)
}

/**
 * Missions whose repo source path equals `cwd` — the ones to pin above the
 * editor in a session opened in that repo. Comparison is on normalized
 * absolute paths; both `repoPath` (captured at /cc new) and `ctx.cwd` come
 * from the same pi process (`process.cwd()`), so plain equality holds.
 *
 * Result is ordered for display: active statuses first, most recently
 * updated first within a status, terminal missions (completed/cancelled)
 * dimmed at the bottom.
 */
export function relatedMissions(
	missions: readonly MissionSummary[],
	cwd: string,
): MissionSummary[] {
	const cwdNorm = normalizePath(cwd)
	return missions
		.filter((m) => {
			// The session's cwd inside the source repo, or inside this mission's
			// worktrees ($HOME/.command-center/worktrees/<missionId>/…) — a role
			// session (lead = integration, owner = work-N) counts as attached.
			if (normalizePath(m.repoPath) === cwdNorm) return true
			return isInsideMissionWorktrees(m, cwd)
		})
		.sort((a, b) => {
			const byStatus = STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
			if (byStatus !== 0) return byStatus
			// ISO timestamps compare lexicographically.
			return b.updatedAt.localeCompare(a.updatedAt)
		})
}

/** Cap an over-long title with an ellipsis. */
function fitTitle(title: string): string {
	if (title.length <= MAX_TITLE_CHARS) return title
	return `${title.slice(0, MAX_TITLE_CHARS)}…`
}

/** Identity fg: renderers' default when no theme is available. */
const IDENTITY_FG = (_color: ThemeColor, text: string) => text

/** The two supported widget views. */
export type CommandCenterWidgetMode =
	| { kind: "normal"; rows: readonly MissionWidgetRow[] }
	| { kind: "mission-lead"; row: MissionWidgetRow }

function totalItems(counts: MissionSummary["itemCounts"]): number {
	return Object.values(counts).reduce((sum, count) => sum + count, 0)
}

/** Choose the tree connector for a row's position in the visible list. */
function connector(isLast: boolean): string {
	return isLast ? "┗━" : "┣━"
}

/** Render the compact mission row used outside a Mission Lead session. */
export function normalMissionLine(
	{ mission, sessionAttached }: MissionWidgetRow,
	fg: (color: ThemeColor, text: string) => string = IDENTITY_FG,
	isLast = true,
): string {
  const state = sessionAttached
    ? fg("accent", "Running...")
    : fg(
      STATUS_COLOR[mission.status],
      `Paused[${STATUS_LABEL[mission.status]}]`,
    );
	const inProgress = fg("accent", String(mission.itemCounts.in_progress))
	const completed = fg("success", String(mission.itemCounts.accepted))
	const conn = fg("dim", connector(isLast))
	return `${ROW_LEFT_PADDING}${conn} ${fitTitle(mission.title)} (${mission.id}) ${state} (${inProgress} + ${completed} / ${totalItems(mission.itemCounts)})`
}

interface StatePresentation {
	label: string
	color: ThemeColor
}

function spinner(frame: number): string {
	return SPINNER_FRAMES[Math.abs(frame) % SPINNER_FRAMES.length] ?? "-"
}

function liveActivityState(
	activity: ActivityState,
	spinnerFrame: number,
): StatePresentation {
	let label: string
	switch (activity.phase) {
		case "starting":
			label = "Starting"
			break
		case "thinking":
			label = "Thinking"
			break
		case "writing":
			label = "Writing"
			break
		case "tool": {
			const tool = activity.tool?.trim() || "tool"
			label = `Calling ${tool}`
			break
		}
		case "waiting":
			label = "Continuing"
			break
		case "needs_help":
			label = "Needs help"
			break
		case "idle":
			label = "Idle"
			break
	}

	const animated = activity.phase !== "needs_help" && activity.phase !== "idle"
	return {
		label: animated ? `${label} ${spinner(spinnerFrame)}` : label,
		color: ACTIVITY_COLOR[activity.phase],
	}
}

function fallbackState(status: WorkItemStatus): StatePresentation {
	const label = {
		pending: "Queued",
		in_progress: "Waiting",
		ready_for_review: "Awaiting review",
		accepted: "Accepted",
		cancelled: "Cancelled",
	}[status]
	return { label, color: STATUS_COLOR[status] }
}

function currentState(
	item: WorkItemWidgetRow,
	spinnerFrame: number,
): StatePresentation {
	return item.activity
		? liveActivityState(item.activity, spinnerFrame)
		: fallbackState(item.status)
}

/** Render a work-item row used in the Mission Lead view. */
export function missionLeadItemLine(
	item: WorkItemWidgetRow,
	fg: (color: ThemeColor, text: string) => string = IDENTITY_FG,
	isLast = true,
	spinnerFrame = 0,
): string {
	const state = currentState(item, spinnerFrame)
	const conn = fg("dim", connector(isLast))
	return `${ROW_LEFT_PADDING}${conn} ${fg("muted", `#${item.id}`)} ${fitTitle(item.title)}: ${fg(state.color, state.label)}`
}

/** Render the mode-specific header. */
export function commandCenterHeader(
	mode: CommandCenterWidgetMode,
	fg: (color: ThemeColor, text: string) => string,
	bold: (text: string) => string,
	width: number,
): string {
	if (mode.kind === "mission-lead") {
		const { mission } = mode.row
		return truncateToWidth(
			`${HEADER_LEFT_PADDING}${fg("accent", bold(MISSIONS_WIDGET_TITLE))} - Mission Lead @ ${fitTitle(mission.title)} (${mission.id})`,
			width,
		)
	}
	return missionsHeader(mode.rows, fg, bold, width)
}

/** Render rows for either widget mode, capped to avoid an oversized widget. */
export function commandCenterLines(
	mode: CommandCenterWidgetMode,
	fg: (color: ThemeColor, text: string) => string = IDENTITY_FG,
	maxRows = MAX_WIDGET_LINES,
	spinnerFrame = 0,
): string[] {
	if (mode.kind === "normal") {
		const rows = mode.rows
		const visibleRows = rows.slice(0, maxRows)
		const rendered = visibleRows.map((row, index) =>
			normalMissionLine(row, fg, index === visibleRows.length - 1),
		)
		if (rows.length <= maxRows) return rendered
		return [...rendered, `… +${rows.length - maxRows} more`]
	}

	const rows = mode.row.items ?? []
	const visibleRows = rows.slice(0, maxRows)
	const rendered = visibleRows.map((row, index) =>
		missionLeadItemLine(
			row,
			fg,
			index === visibleRows.length - 1,
			spinnerFrame,
		),
	)
	if (rows.length <= maxRows) return rendered
	return [...rendered, `… +${rows.length - maxRows} more`]
}

/** Stable, unstyled content used to skip redundant widget updates. */
export function commandCenterSkeleton(mode: CommandCenterWidgetMode): string {
	const header =
		mode.kind === "mission-lead"
			? `${mode.row.mission.id}:${mode.row.mission.title}`
			: mode.rows
					.map((row) => `${row.mission.id}:${row.mission.title}`)
					.join(",")
	return `${mode.kind}:${header}\n${commandCenterLines(mode).join("\n")}`
}

/** Build the final width-aware widget lines. */
export function renderCommandCenterWidget(
	mode: CommandCenterWidgetMode,
	fg: (color: ThemeColor, text: string) => string,
	bold: (text: string) => string,
	width: number,
	spinnerFrame = 0,
): string[] {
	return [
		commandCenterHeader(mode, fg, bold, width),
		...commandCenterLines(mode, fg, MAX_WIDGET_LINES, spinnerFrame).map(
			(line) => truncateToWidth(line, width),
		),
	]
}

/**
 * The widget's header line, styled like the mini-task widget: a bold accent
 * title followed by a dim summary of the pinned missions
 * (`1 active · 0/2 done`), with no top border. Truncated to `width` columns.
 */
export function missionsHeader(
	rows: readonly MissionWidgetRow[],
	fg: (color: ThemeColor, text: string) => string,
	bold: (text: string) => string,
	width: number,
): string {
	// Mini-task summary shape: `<active> active · <done>/<total> done`.
	const active = rows.filter(
		(r) => r.mission.status !== "completed" && r.mission.status !== "cancelled",
	).length
	const done = rows.filter((r) => r.mission.status === "completed").length
	const summary = `${active} active \u00b7 ${done}/${rows.length} done`
	const title = `${HEADER_LEFT_PADDING}${fg("accent", bold(MISSIONS_WIDGET_TITLE))}  ${fg(
		"dim",
		summary,
	)}`
	return truncateToWidth(title, width)
}
