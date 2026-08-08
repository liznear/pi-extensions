import path from "node:path"
import type { ThemeColor } from "@earendil-works/pi-coding-agent"
import type { MissionStatus, MissionSummary } from "../core/types"

// ---------------------------------------------------------------------------
// Missions pinned above the input editor
//
// While a session runs in a repo, the Command Center pins every mission whose
// repo source path equals the session's cwd above the input editor, so the
// missions that own this checkout stay visible without /cc list.
//
// The widget is a markdown table built here and rendered by pi-tui's Markdown
// component, which owns the width-aware column sizing, cell wrapping and the
// narrow-terminal fallback. This module is pure and dependency-free (mirrors
// cc-completions.ts / cc-highlight.ts): it builds the markdown string and the
// stripTableBorders / missionsTopBorder transforms; cc.ts wires them into the
// setWidget UI (strips the table's borders/header/walls, indents the rows,
// and adds the Command Center title border).
//
// Table columns: id | status | session attached | title. "Session attached"
// is derived from the mission's driver lock file (a live holder = a pi
// process is currently driving the mission).
// ---------------------------------------------------------------------------

/** Widget key used with ctx.ui.setWidget — the pinned missions list. */
export const MISSIONS_WIDGET_KEY = "cc-missions"

/** Title shown in the widget's top border. */
export const MISSIONS_WIDGET_TITLE = "Command Center"

/** Cap the pinned rows at this many (the renderer wraps titles itself). */
export const MAX_WIDGET_LINES = 10

/** Cap a single title's length so a pathological title can't balloon the widget. */
export const MAX_TITLE_CHARS = 120

/** A mission row in the pinned table: the mission plus its live-driver state. */
export interface MissionWidgetRow {
	mission: MissionSummary
	/** True when a live process holds the mission's driver lock (session attached). */
	sessionAttached: boolean
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

/**
 * Absolute, normalized form of a path for comparison. Handles trailing
 * slashes and `..`; relative paths resolve against the process cwd.
 */
function normalizePath(p: string): string {
	return path.resolve(p)
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
		.filter((m) => normalizePath(m.repoPath) === cwdNorm)
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
 * table header row required by GFM syntax, then one row per mission capped at
 * `maxRows` (default MAX_WIDGET_LINES) with a trailing "… +N more" row. The
 * header row is dropped at render time (stripTableBorders); the widget's
 * top border frames the table in the UI layer.
 *
 * `fg` styles the status and session cells with ANSI colors (the Markdown
 * renderer passes cell text through, and its width math ignores ANSI).
 */
export function buildMissionsMarkdown(
	rows: readonly MissionWidgetRow[],
	fg: (color: ThemeColor, text: string) => string = IDENTITY_FG,
	maxRows = MAX_WIDGET_LINES,
): string {
	const shown = rows.slice(0, maxRows)
	const lines = [
		"| ID | STATUS | SESSION | TITLE |",
		"| --- | --- | --- | --- |",
		...shown.map(({ mission, sessionAttached }) => {
			const title = escapeCell(fitTitle(mission.title))
			const status = fg(
				STATUS_COLOR[mission.status],
				STATUS_LABEL[mission.status],
			)
			const session = fg(
				sessionAttached ? "accent" : "dim",
				sessionAttached ? "attached" : "detached",
			)
			return `| ${mission.id} | ${status} | ${session} | ${title} |`
		}),
	]
	const hidden = rows.length - shown.length
	if (hidden > 0) lines.push(`|  |  |  | … +${hidden} more |`)
	return lines.join("\n")
}

/** A line consisting solely of table box-drawing characters (a border rule). */
const TABLE_BORDER_RE = /^[─┬┼┴┌├└┐┤┘]+$/

/**
 * The widget's top border: `─── Command Center ` followed by table dashes to
 * the right edge. The title is colored accent; the dashes dim. Exact `width`
 * columns.
 */
export function missionsTopBorder(
	title: string,
	fg: (color: ThemeColor, text: string) => string,
	width: number,
): string {
	// Prefix `─── ` + label + ` ` consume width - 5 columns; clamp the label.
	const label = title.slice(0, Math.max(0, width - 5))
	const fill = Math.max(0, width - label.length - 5)
	const dashes = "─".repeat(fill)
	return fg("dim", "─── ") + fg("accent", label) + fg("dim", ` ${dashes}`)
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
