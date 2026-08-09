import path from "node:path"
import type { ThemeColor } from "@earendil-works/pi-coding-agent"
import { truncateToWidth } from "@earendil-works/pi-tui"
import type {
	MissionStatus,
	MissionSummary,
	WorkItemStatus,
} from "../core/types"

// ---------------------------------------------------------------------------
// Missions pinned above the input editor
//
// While a session runs in a repo, the Command Center pins every mission whose
// repo source path equals the session's cwd above the input editor, so the
// missions that own this checkout stay visible without /cc list.
//
// The widget is a markdown table built here and rendered by pi-tui's Markdown
// component, which owns the width-aware column sizing, cell wrapping and the
// narrow-terminal fallback. This module is pure (mirrors cc-completions.ts /
// cc-highlight.ts): it builds the markdown string and the stripTableBorders /
// missionsHeader transforms; cc.ts wires them into the setWidget UI (strips
// the table's borders/header/walls, indents the rows, and prepends the
// Command Center header line styled like the mini-task widget).
//
// Table columns: id | status | session attached | title. "Session attached"
// is derived from the mission's driver lock file (a live holder = a pi
// process is currently driving the mission). The work items of a mission are
// shown only when the session is attached to it (cwd inside its worktrees
// dir) — the main repo view stays mission-level.
// ---------------------------------------------------------------------------

/** Widget key used with ctx.ui.setWidget — the pinned missions list. */
export const MISSIONS_WIDGET_KEY = "cc-missions"

/** Title shown in the widget's top border. */
export const MISSIONS_WIDGET_TITLE = "Command Center"

/** Cap the pinned rows at this many (the renderer wraps titles itself). */
export const MAX_WIDGET_LINES = 20

/** Cap a single title's length so a pathological title can't balloon the widget. */
export const MAX_TITLE_CHARS = 120

/** Live per-role activity for a work item, driven by forwarded session events. */
export interface ActivityState {
	phase: "thinking" | "writing" | "tool" | "idle"
	/** The tool name while `phase === "tool"`. */
	tool?: string
}

/** A work item row nested under its mission in the combined widget. */
export interface WorkItemWidgetRow {
	id: number
	title: string
	status: WorkItemStatus
	/** The owner's live activity (absent when idle or the session is parked). */
	activity?: ActivityState
}

/** A mission row in the pinned table: the mission plus its live-driver state. */
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

/** Per-status display color. */
const STATUS_COLOR: Record<MissionStatus, ThemeColor> = {
	pending: "muted",
	in_progress: "accent",
	ready_for_acceptance: "warning",
	completed: "success",
	cancelled: "dim",
}

/** Readable, title-cased labels for work-item statuses. */
const WORK_ITEM_STATUS_LABEL: Record<WorkItemStatus, string> = {
	pending: "Pending",
	in_progress: "In progress",
	ready_for_review: "Ready for review",
	accepted: "Accepted",
	cancelled: "Cancelled",
}

/** Per-status display color for work items. */
const WORK_ITEM_STATUS_COLOR: Record<WorkItemStatus, ThemeColor> = {
	pending: "muted",
	in_progress: "accent",
	ready_for_review: "warning",
	accepted: "success",
	cancelled: "dim",
}

/** Cap a tool name in the activity cell so a long path can't balloon the row. */
const MAX_TOOL_CHARS = 24

/** Render a work item's live activity cell (dim "—" when idle/absent). */
function activityCell(
	activity: ActivityState | undefined,
	fg: (color: ThemeColor, text: string) => string,
): string {
	if (!activity || activity.phase === "idle") return fg("dim", "—")
	if (activity.phase === "thinking") return fg("accent", "💭 thinking…")
	if (activity.phase === "writing") return fg("accent", "✍️ writing…")
	const tool = (activity.tool ?? "tool").trim()
	const shown =
		tool.length <= MAX_TOOL_CHARS ? tool : `${tool.slice(0, MAX_TOOL_CHARS)}…`
	return fg("accent", `🔧 ${shown}`)
}

/**
 * Absolute, normalized form of a path for comparison. Handles trailing
 * slashes and `..`; relative paths resolve against the process cwd.
 */
function normalizePath(p: string): string {
	return path.resolve(p)
}

/**
 * The normalized prefix of a mission's worktrees dir:
 * `<repo>/.command-center/worktrees/<missionId>`. A role session running
 * there (lead = integration, owner = work-N) is attached to the mission.
 */
function missionWorktreesPrefix(mission: {
	repoPath: string
	id: string
}): string {
	return normalizePath(
		path.join(mission.repoPath, ".command-center", "worktrees", mission.id),
	)
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
 * absolute paths; both `repoPath` (captured at /cc start) and `ctx.cwd` come
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
			// worktrees (<repo>/.command-center/worktrees/<missionId>/…) — a role
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

/** Escape markdown table syntax (pipes, backslashes) in a cell value. */
function escapeCell(text: string): string {
	return text.replace(/[\\|]/g, (c) => `\\${c}`)
}

/** Cap an over-long title with an ellipsis (the renderer wraps the rest). */
function fitTitle(title: string): string {
	if (title.length <= MAX_TITLE_CHARS) return title
	return `${title.slice(0, MAX_TITLE_CHARS)}…`
}

/** Identity fg: buildMissionsMarkdown's default when no theme is available. */
const IDENTITY_FG = (_color: ThemeColor, text: string) => text

/**
 * Build the markdown document for the pinned-missions widget: a (dummy)
 * table header row required by GFM syntax, then one row per mission followed
 * by its work-item rows, capped at `maxRows` total rows (default
 * MAX_WIDGET_LINES) with a trailing "… +N more" row. The header row is
 * dropped at render time (stripTableBorders); the widget's header line frames
 * the table in the UI layer. Rows are prefixed with mini-task-style tree
 * branches inside the first cell: `┣━` for every row but the last, `┗━` for
 * the last, and work items hang off their mission with a `┃` continuation
 * (kept even for the last mission, so the renderer can't strip it), keeping
 * the columns aligned after the walls are stripped.
 *
 * `fg` styles the status and session cells with ANSI colors (the Markdown
 * renderer passes cell text through, and its width math ignores ANSI).
 */
function missionLine(
	{ mission, sessionAttached }: MissionWidgetRow,
	fg: (color: ThemeColor, text: string) => string,
): string {
	const title = escapeCell(fitTitle(mission.title))
	const status = fg(STATUS_COLOR[mission.status], STATUS_LABEL[mission.status])
	const session = fg(
		sessionAttached ? "accent" : "dim",
		sessionAttached ? "attached" : "detached",
	)
	return `| ${mission.id} | ${status} | ${session} | ${title} |`
}

function workItemLine(
	item: WorkItemWidgetRow,
	fg: (color: ThemeColor, text: string) => string,
): string {
	const title = escapeCell(fitTitle(item.title))
	const status = fg(
		WORK_ITEM_STATUS_COLOR[item.status],
		WORK_ITEM_STATUS_LABEL[item.status],
	)
	const session = activityCell(item.activity, fg)
	return `| #${item.id} | ${status} | ${session} | ${title} |`
}

export function buildMissionsMarkdown(
	rows: readonly MissionWidgetRow[],
	fg: (color: ThemeColor, text: string) => string = IDENTITY_FG,
	maxRows = MAX_WIDGET_LINES,
): string {
	// Flatten each mission into its row plus its work-item rows; the cap counts
	// both, so one mission can't crowd out the rest. Track each line's depth
	// (mission 0, work item 1) so the tree branches can be drawn afterwards.
	const lines: Array<{ line: string; depth: number }> = []
	let hidden = 0
	for (const row of rows) {
		const block = [{ line: missionLine(row, fg), depth: 0 }]
		for (const item of row.items ?? []) {
			block.push({ line: workItemLine(item, fg), depth: 1 })
		}
		const remaining = maxRows - lines.length
		if (remaining <= 0) {
			hidden += block.length
		} else if (block.length <= remaining) {
			lines.push(...block)
		} else {
			lines.push(...block.slice(0, remaining))
			hidden += block.length - remaining
		}
	}
	// Mini-task-style tree branches in the first cell: `┣━` for every row but
	// the last, `┗━` for the last. Work items indent under their mission with
	// a `┃` continuation, kept even for the last mission (the Markdown
	// renderer would strip a space-only continuation, breaking the tree).
	const branched = lines.map(({ line, depth }, index) => {
		const branch = index === lines.length - 1 ? "┗━ " : "┣━ "
		const prefix = depth === 0 ? branch : `┃  ${branch}`
		return line.replace(/^\| /, `| ${prefix}`)
	})
	const out = [
		"| ID | STATUS | SESSION | TITLE |",
		"| --- | --- | --- | --- |",
		...branched,
	]
	if (hidden > 0) out.push(`|  |  |  | … +${hidden} more |`)
	return out.join("\n")
}

/** A line consisting solely of table box-drawing characters (a border rule). */
const TABLE_BORDER_RE = /^[─┬┼┴┌├└┐┤┘]+$/

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
	const title = ` ${fg("accent", bold(MISSIONS_WIDGET_TITLE))}  ${fg(
		"dim",
		summary,
	)}`
	return truncateToWidth(title, width)
}

/**
 * Turn a rendered markdown table into the widget's open table: drop the
 * horizontal border rules (top, separator, bottom), the header row and the
 * outer `│` walls, keeping the inner column separators and per-column padding
 * (so wrapped continuation lines stay aligned). Tolerates the renderer's
 * line padding.
 */
export function stripTableBorders(lines: readonly string[]): string[] {
	let headerDropped = false
	const out: string[] = []
	for (const line of lines) {
		if (TABLE_BORDER_RE.test(line.trim())) continue
		if (!line.includes("│")) {
			out.push(line.trimEnd())
			continue
		}
		// The first pipe line is the (dummy) markdown header row — drop it.
		if (!headerDropped) {
			headerDropped = true
			continue
		}
		// Row line: "│ cell │ cell │" — drop the outer walls, keep the
		// ` │ ` column separators; empty leading cells keep the indent.
		// Regex (not slice) so rows the renderer padded to the full width
		// with trailing spaces still lose their walls.
		out.push(line.replace(/^ *│ /, "").replace(/ │ *$/, "").trimEnd())
	}
	return out
}
