import { describe, expect, test } from "bun:test"
import type { ThemeColor } from "@earendil-works/pi-coding-agent"
import type { MarkdownTheme } from "@earendil-works/pi-tui"
import { Markdown } from "@earendil-works/pi-tui"
import type { MissionSummary, WorkItemCounts } from "../../core/types"
import {
	buildMissionsMarkdown,
	MAX_TITLE_CHARS,
	MAX_WIDGET_LINES,
	MISSIONS_WIDGET_TITLE,
	type MissionWidgetRow,
	missionsTopBorder,
	relatedMissions,
	stripTableBorders,
} from "../cc-missions-widget"

/** Stub fg rendering color markers for readable assertions. */
const fg = (color: ThemeColor, text: string) => `<${color}>${text}</${color}>`

const EMPTY_COUNTS: WorkItemCounts = {
	pending: 0,
	in_progress: 0,
	ready_for_review: 0,
	accepted: 0,
	cancelled: 0,
}

function mission(
	partial: Partial<MissionSummary> & { id: string },
): MissionSummary {
	return {
		title: "Mission",
		status: "in_progress",
		repoPath: "/repo/a",
		itemCounts: EMPTY_COUNTS,
		updatedAt: "2025-01-01T00:00:00.000Z",
		...partial,
	}
}

function wrow(
	partial: Partial<Omit<MissionWidgetRow, "mission">> & {
		id: string
		mission?: Partial<MissionSummary>
	},
): MissionWidgetRow {
	const { mission: missionOverrides, sessionAttached = false, id } = partial
	return {
		mission: mission({ id, ...missionOverrides }),
		sessionAttached,
	}
}

// ---------------------------------------------------------------------------
// relatedMissions — cwd filtering
// ---------------------------------------------------------------------------

describe("relatedMissions — cwd filtering", () => {
	test("includes missions whose repoPath equals the cwd", () => {
		const missions = [
			mission({ id: "m1", repoPath: "/repo/a" }),
			mission({ id: "m2", repoPath: "/repo/b" }),
			mission({ id: "m3", repoPath: "/repo/a" }),
		]
		expect(relatedMissions(missions, "/repo/a").map((m) => m.id)).toEqual([
			"m1",
			"m3",
		])
	})

	test("returns [] when no mission targets the cwd", () => {
		const missions = [mission({ id: "m1", repoPath: "/repo/b" })]
		expect(relatedMissions(missions, "/repo/a")).toEqual([])
	})

	test("handles empty input", () => {
		expect(relatedMissions([], "/repo/a")).toEqual([])
	})
})

describe("relatedMissions — path normalization", () => {
	test("trailing slash matches", () => {
		const missions = [mission({ id: "m1", repoPath: "/repo/a" })]
		expect(relatedMissions(missions, "/repo/a/").map((m) => m.id)).toEqual([
			"m1",
		])
	})

	test("dot segment matches", () => {
		const missions = [mission({ id: "m1", repoPath: "/repo/a" })]
		expect(relatedMissions(missions, "/repo/a/.").map((m) => m.id)).toEqual([
			"m1",
		])
	})

	test("dot-dot segment resolves up a directory", () => {
		const missions = [mission({ id: "m1", repoPath: "/repo/a" })]
		expect(
			relatedMissions(missions, "/repo/a/sub/..").map((m) => m.id),
		).toEqual(["m1"])
	})

	test("worktree path does NOT match the source repo", () => {
		const missions = [mission({ id: "m1", repoPath: "/repo/a" })]
		expect(
			relatedMissions(missions, "/repo/a/.command-center/m1").map((m) => m.id),
		).toEqual([])
	})
})

// ---------------------------------------------------------------------------
// relatedMissions — ordering
// ---------------------------------------------------------------------------

describe("relatedMissions — ordering", () => {
	test("active missions first, terminal missions last", () => {
		const missions = [
			mission({ id: "m-completed", status: "completed" }),
			mission({ id: "m-pending", status: "pending" }),
			mission({ id: "m-in-progress", status: "in_progress" }),
			mission({ id: "m-ready", status: "ready_for_acceptance" }),
			mission({ id: "m-cancelled", status: "cancelled" }),
		]
		expect(relatedMissions(missions, "/repo/a").map((m) => m.id)).toEqual([
			"m-in-progress",
			"m-ready",
			"m-pending",
			"m-completed",
			"m-cancelled",
		])
	})

	test("most recently updated first within a status", () => {
		const missions = [
			mission({ id: "m-old", updatedAt: "2025-01-01T00:00:00.000Z" }),
			mission({ id: "m-new", updatedAt: "2025-01-02T00:00:00.000Z" }),
		]
		expect(relatedMissions(missions, "/repo/a").map((m) => m.id)).toEqual([
			"m-new",
			"m-old",
		])
	})

	test("does not mutate the input array", () => {
		const missions = [
			mission({ id: "m2", updatedAt: "2025-01-02T00:00:00.000Z" }),
			mission({ id: "m1", updatedAt: "2025-01-01T00:00:00.000Z" }),
		]
		relatedMissions(missions, "/repo/a")
		expect(missions.map((m) => m.id)).toEqual(["m2", "m1"])
	})
})

// ---------------------------------------------------------------------------
// buildMissionsMarkdown
// ---------------------------------------------------------------------------

describe("buildMissionsMarkdown", () => {
	test("renders a dummy header row and one row per mission", () => {
		const md = buildMissionsMarkdown([
			wrow({
				id: "abc12345",
				mission: { title: "Fix flaky tests" },
				sessionAttached: true,
			}),
		])
		expect(md).toBe(
			[
				"| ID | STATUS | SESSION | TITLE |",
				"| --- | --- | --- | --- |",
				"| abc12345 | In progress | attached | Fix flaky tests |",
			].join("\n"),
		)
	})

	test("shows detached when no session is attached", () => {
		const md = buildMissionsMarkdown([wrow({ id: "m1" })])
		expect(md).toContain("| m1 | In progress | detached | Mission |")
	})

	test("colors status and session cells via fg", () => {
		const md = buildMissionsMarkdown(
			[
				wrow({
					id: "m1",
					mission: { status: "completed" },
					sessionAttached: true,
				}),
				wrow({ id: "m2" }),
			],
			fg,
		)
		expect(md).toContain(
			"| m1 | <success>Completed</success> | <accent>attached</accent> | Mission |",
		)
		expect(md).toContain(
			"| m2 | <accent>In progress</accent> | <dim>detached</dim> | Mission |",
		)
	})

	test("maps every status to a readable label", () => {
		const statuses = [
			["pending", "muted", "Pending"],
			["in_progress", "accent", "In progress"],
			["ready_for_acceptance", "warning", "Ready for acceptance"],
			["completed", "success", "Completed"],
			["cancelled", "dim", "Cancelled"],
		] as const
		for (const [status, color, label] of statuses) {
			const md = buildMissionsMarkdown(
				[wrow({ id: "m1", mission: { status } })],
				fg,
			)
			expect(md).toContain(`<${color}>${label}</${color}>`)
		}
	})

	test("escapes pipes in titles so they cannot break the table", () => {
		const md = buildMissionsMarkdown([
			wrow({ id: "m1", mission: { title: "pipe | and \\ backslash" } }),
		])
		expect(md).toContain("| pipe \\| and \\\\ backslash |")
	})

	test("caps rows at maxRows with a +N more row", () => {
		const rows = Array.from({ length: MAX_WIDGET_LINES + 2 }, (_, i) =>
			wrow({ id: `m${i}` }),
		)
		const md = buildMissionsMarkdown(rows)
		const dataLines = md
			.split("\n")
			.filter(
				(l) => l.includes(" | attached | ") || l.includes(" | detached | "),
			)
		expect(dataLines).toHaveLength(MAX_WIDGET_LINES)
		expect(md).toContain(`|  |  |  | … +2 more |`)
	})

	test("honors an explicit maxRows", () => {
		const rows = Array.from({ length: 5 }, (_, i) => wrow({ id: `m${i}` }))
		const md = buildMissionsMarkdown(rows, undefined, 2)
		const dataLines = md
			.split("\n")
			.filter(
				(l) => l.includes(" | attached | ") || l.includes(" | detached | "),
			)
		expect(dataLines).toHaveLength(2)
		expect(md).toContain("… +3 more")
	})

	test("no +N more row when everything fits", () => {
		const md = buildMissionsMarkdown([wrow({ id: "m1" })])
		expect(md).not.toContain("more")
	})

	test("truncates titles longer than MAX_TITLE_CHARS", () => {
		const long = "x".repeat(MAX_TITLE_CHARS + 10)
		const md = buildMissionsMarkdown([
			wrow({ id: "m1", mission: { title: long } }),
		])
		expect(md).toContain(`| ${long.slice(0, MAX_TITLE_CHARS)}… |`)
	})
})

// ---------------------------------------------------------------------------
// stripTableBorders
// ---------------------------------------------------------------------------

describe("stripTableBorders", () => {
	test("drops border rules, the header row, and the outer walls", () => {
		const lines = [
			"┌──────────┬──────────────┐",
			"│ ID       │ TITLE         │",
			"├──────────┼──────────────┤",
			"│ abc12345 │ Fix flaky     │",
			"│ x9y8z7w6 │ Refactor      │",
			"└──────────┴──────────────┘",
		]
		expect(stripTableBorders(lines)).toEqual([
			"abc12345 │ Fix flaky",
			"x9y8z7w6 │ Refactor",
		])
	})

	test("keeps inner column separators and continuation indentation", () => {
		const cell = (w: number, s = "") => s.padEnd(w)
		const row = (id: string, status: string, session: string, title: string) =>
			`│ ${cell(10, id)} │ ${cell(14, status)} │ ${cell(
				9,
				session,
			)} │ ${cell(9, title)} │`
		const lines = [
			row("ID", "STATUS", "SESSION", "TITLE"),
			row("abc12345", "in_progress", "yes", "Fix"),
			row("", "", "", "flaky"),
		]
		expect(stripTableBorders(lines)).toEqual([
			"abc12345   │ in_progress    │ yes       │ Fix",
			"           │                │           │ flaky",
		])
	})

	test("tolerates the renderer's line padding around borders", () => {
		const lines = [
			" ┌──────┬─────┐ ",
			" │ ID   │ TITLE │ ",
			" │ a    │ b     │ ",
			" └──────┴─────┘ ",
		]
		expect(stripTableBorders(lines)).toEqual(["a    │ b"])
	})

	test("strips the right wall even when the renderer pads the row to full width", () => {
		const lines = [
			"│ ID    │ TITLE          │                 ",
			"│ abc12 │ Ship           │                 ",
		]
		expect(stripTableBorders(lines)).toEqual(["abc12 │ Ship"])
	})

	test("keeps non-border lines untouched", () => {
		const lines = ["Command Center", "", "plain text"]
		expect(stripTableBorders(lines)).toEqual(lines)
	})
})

// ---------------------------------------------------------------------------
// missionsTopBorder
// ---------------------------------------------------------------------------

describe("missionsTopBorder", () => {
	test("renders ─── Title ─… with the title in accent and dashes dim", () => {
		const border = missionsTopBorder("Command Center", fg, 40)
		expect(border).toBe(
			"<dim>─── </dim><accent>Command Center</accent><dim> " +
				"─".repeat(21) +
				"</dim>",
		)
	})

	test("clamps a title longer than the width", () => {
		const border = missionsTopBorder("Command Center is quite long", fg, 20)
		expect(border).toBe(
			"<dim>─── </dim><accent>Command Center </accent><dim> </dim>",
		)
	})

	test("fills to exactly the width", () => {
		const identity = (_color: ThemeColor, text: string) => text
		expect(missionsTopBorder("Command Center", identity, 60)).toHaveLength(60)
	})
})

// ---------------------------------------------------------------------------
// Integration: the markdown string actually renders as a pipe table through
// pi-tui's Markdown component (identity theme — no ANSI noise).
// ---------------------------------------------------------------------------

const mdTheme: MarkdownTheme = {
	heading: (t) => t,
	link: (t) => t,
	linkUrl: (t) => t,
	code: (t) => t,
	codeBlock: (t) => t,
	codeBlockBorder: (t) => t,
	quote: (t) => t,
	quoteBorder: (t) => t,
	hr: (t) => t,
	listBullet: (t) => t,
	bold: (t) => t,
	italic: (t) => t,
	strikethrough: (t) => t,
	underline: (t) => t,
}

describe("Markdown integration", () => {
	// Identity fg: border lines render as plain text (the per-color mapping
	// is covered by the missionsTopBorder tests).
	const plain = (_color: ThemeColor, text: string) => text

	const frame = (md: string, width: number) => {
		const table = stripTableBorders(
			new Markdown(md, 0, 0, mdTheme).render(width),
		).map((line) => (line ? `  ${line}` : line)) // rows indented
		return [missionsTopBorder(MISSIONS_WIDGET_TITLE, plain, width), ...table]
	}

	test("renders a top border above indented, open pipe rows", () => {
		const md = buildMissionsMarkdown([
			wrow({
				id: "abc12345",
				mission: { title: "Fix flaky tests" },
				sessionAttached: true,
			}),
		])
		const lines = frame(md, 60)
		// Top border carries the title; no bottom border.
		expect(lines[0]!).toBe(`─── Command Center ${`─`.repeat(41)}`)
		expect(lines.every((l) => !/^[─└]+$/.test(l))).toBe(true)
		// Rows are indented, but the top border is not.
		expect(lines.every((l) => !l.startsWith("│"))).toBe(true)
		expect(lines.every((l) => !l.includes("TITLE"))).toBe(true)
		expect(lines.slice(1).every((l) => l.startsWith("  "))).toBe(true)
		// No row keeps its right wall, even when the renderer padded it.
		expect(lines.every((l) => !l.trimEnd().endsWith("│"))).toBe(true)
		// Inner column separators and content kept.
		expect(lines.some((l) => l.includes("  abc12345 │"))).toBe(true)
	})

	test("keeps ANSI colors from the status/session cells through rendering", () => {
		const esc = String.fromCharCode(27)
		const ansi = (color: ThemeColor, text: string) =>
			`${esc}[${color === "accent" ? "36" : "31"}m${text}${esc}[0m`
		const md = buildMissionsMarkdown(
			[wrow({ id: "abc12345", mission: { title: "Fix flaky tests" } })],
			ansi,
		)
		const lines = stripTableBorders(new Markdown(md, 0, 0, mdTheme).render(60))
		const row = lines.find((l) => l.includes("abc12345"))!
		expect(row).toContain(`${esc}[36mIn progress${esc}[0m`)
		expect(row).toContain(`${esc}[31mdetached${esc}[0m`)
	})

	test("wraps long titles inside table cells at narrow widths", () => {
		const md = buildMissionsMarkdown([
			wrow({ id: "abc12345", mission: { title: "a".repeat(200) } }),
		])
		const lines = frame(md, 40)
		// The renderer wraps the 200-char title across multiple cell lines.
		const rowLines = lines.filter((l) => l.includes("│"))
		expect(rowLines.length).toBeGreaterThan(2)
		expect(rowLines.every((l) => l.length <= 40)).toBe(true)
	})
})
