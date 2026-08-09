import { describe, expect, test } from "bun:test"
import type { ThemeColor } from "@earendil-works/pi-coding-agent"
import { visibleWidth } from "@earendil-works/pi-tui"
import type { MissionSummary, WorkItemCounts } from "../../core/types"
import {
	commandCenterHeader,
	commandCenterLines,
	isInsideMissionWorktrees,
	MAX_TITLE_CHARS,
	MAX_WIDGET_LINES,
	type MissionWidgetRow,
	missionLeadItemLine,
	missionsHeader,
	normalMissionLine,
	relatedMissions,
} from "../cc-missions-widget"

const fg = (color: ThemeColor, text: string) => `<${color}>${text}</${color}>`
const identity = (_color: ThemeColor, text: string) => text
const noBold = (text: string) => text

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
	const {
		mission: missionOverrides,
		sessionAttached = false,
		id,
		items,
	} = partial
	return {
		mission: mission({ id, ...missionOverrides }),
		sessionAttached,
		...(items ? { items } : {}),
	}
}

describe("relatedMissions", () => {
	test("filters by repo and includes a mission worktree", () => {
		const missions = [
			mission({ id: "m1", repoPath: "/repo/a" }),
			mission({ id: "m2", repoPath: "/repo/b" }),
		]
		expect(relatedMissions(missions, "/repo/a").map((m) => m.id)).toEqual([
			"m1",
		])
		expect(
			relatedMissions(
				missions,
				"/repo/a/.command-center/worktrees/m1/integration",
			).map((m) => m.id),
		).toEqual(["m1"])
	})

	test("normalizes paths and orders active missions first", () => {
		const missions = [
			mission({
				id: "done",
				status: "completed",
				updatedAt: "2025-01-03T00:00:00.000Z",
			}),
			mission({ id: "active", status: "in_progress" }),
		]
		expect(relatedMissions(missions, "/repo/a/.").map((m) => m.id)).toEqual([
			"active",
			"done",
		])
	})
})

describe("isInsideMissionWorktrees", () => {
	const m = mission({ id: "m1", repoPath: "/repo/a" })

	test("matches the integration and owner worktrees, not sibling paths", () => {
		expect(
			isInsideMissionWorktrees(
				m,
				"/repo/a/.command-center/worktrees/m1/integration",
			),
		).toBe(true)
		expect(
			isInsideMissionWorktrees(
				m,
				"/repo/a/.command-center/worktrees/m1/work-2",
			),
		).toBe(true)
		expect(
			isInsideMissionWorktrees(m, "/repo/a/.command-center/worktrees/m1x"),
		).toBe(false)
	})
})

describe("mode-specific widget rendering", () => {
	test("normal mode renders a compact mission row and colored counts", () => {
		const row = wrow({
			id: "m1",
			mission: {
				title: "Ship feature",
				itemCounts: {
					pending: 1,
					in_progress: 2,
					ready_for_review: 0,
					accepted: 3,
					cancelled: 0,
				},
			},
			sessionAttached: true,
		})
		expect(normalMissionLine(row, fg)).toBe(
			"  ┗━ Ship feature (m1) <accent>Running...</accent> (<accent>2</accent> + <success>3</success> / 6)",
		)
	})

	test("normal mode shows the paused mission status", () => {
		const row = wrow({
			id: "m2",
			mission: { status: "ready_for_acceptance" },
		})
		expect(normalMissionLine(row, fg)).toContain(
			"<warning>Paused[Ready for acceptance]</warning>",
		)
	})

	test("Mission Lead mode renders the item number and colored activity", () => {
		const item = {
			id: 7,
			title: "Implement widget",
			status: "in_progress" as const,
			activity: { phase: "tool" as const, tool: "write" },
		}
		expect(missionLeadItemLine(item, fg)).toBe(
			"  ┗━ <muted>#7</muted> Implement widget: <warning>Calling write -</warning>",
		)
	})

	test("Mission Lead header identifies the mission", () => {
		const row = wrow({ id: "m3", mission: { title: "Ship feature" } })
		expect(
			commandCenterHeader({ kind: "mission-lead", row }, identity, noBold, 80),
		).toBe("Command Center - Mission Lead @ Ship feature (m3)")
	})

	test("normal mode does not expand work items", () => {
		const row = wrow({
			id: "m4",
			items: [{ id: 1, title: "Hidden", status: "pending" }],
		})
		expect(commandCenterLines({ kind: "normal", rows: [row] })).toEqual([
			normalMissionLine(row),
		])
	})

	test("Mission Lead mode shows all work items", () => {
		const row = wrow({
			id: "m5",
			items: [
				{ id: 1, title: "First", status: "pending" },
				{ id: 2, title: "Second", status: "accepted" },
			],
		})
		expect(commandCenterLines({ kind: "mission-lead", row })).toEqual([
			"  ┣━ #1 First: Queued",
			"  ┗━ #2 Second: Accepted",
		])
	})

	test("uses a branch connector for non-final rows", () => {
		const row = wrow({
			id: "m-connectors",
			items: [
				{ id: 1, title: "First", status: "pending" },
				{ id: 2, title: "Last", status: "pending" },
			],
		})
		expect(commandCenterLines({ kind: "mission-lead", row })).toEqual([
			"  ┣━ #1 First: Queued",
			"  ┗━ #2 Last: Queued",
		])
	})

	test("uses a stable ASCII spinner frame", () => {
		const item = {
			id: 3,
			title: "Implement widget",
			status: "in_progress" as const,
			activity: { phase: "thinking" as const },
		}
		expect(missionLeadItemLine(item, fg, true, 2)).toBe(
			"  ┗━ <muted>#3</muted> Implement widget: <accent>Thinking |</accent>",
		)
	})

	test("caps the widget rows", () => {
		const row = wrow({
			id: "m6",
			items: Array.from({ length: MAX_WIDGET_LINES + 1 }, (_, i) => ({
				id: i + 1,
				title: `Item ${i + 1}`,
				status: "pending" as const,
			})),
		})
		const lines = commandCenterLines({ kind: "mission-lead", row })
		expect(lines).toHaveLength(MAX_WIDGET_LINES + 1)
		expect(lines.at(-1)).toBe("… +1 more")
	})

	test("caps titles and respects header width", () => {
		const row = wrow({
			id: "m7",
			mission: { title: "x".repeat(MAX_TITLE_CHARS + 10) },
		})
		expect(normalMissionLine(row)).toContain(`${"x".repeat(MAX_TITLE_CHARS)}…`)
		const header = commandCenterHeader(
			{ kind: "mission-lead", row },
			identity,
			noBold,
			12,
		)
		expect(visibleWidth(header)).toBeLessThanOrEqual(12)
	})
})

describe("missionsHeader", () => {
	test("keeps the normal-mode mini-task summary", () => {
		const header = missionsHeader(
			[
				wrow({ id: "m1", mission: { status: "in_progress" } }),
				wrow({ id: "m2", mission: { status: "completed" } }),
			],
			fg,
			noBold,
			80,
		)
		expect(header).toBe(
			" <accent>Command Center</accent>  <dim>1 active · 1/2 done</dim>",
		)
	})
})
