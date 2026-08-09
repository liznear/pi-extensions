import { describe, expect, test } from "bun:test"
import type { MissionSummary } from "../../core/types"
import { ccCompletionForCursor } from "../cc-completions"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MISSIONS: MissionSummary[] = [
	{
		id: "mission-1",
		title: "Extract cc completions",
		status: "in_progress",
		repoPath: "/tmp/cc-extensions",
		itemCounts: {
			pending: 0,
			in_progress: 1,
			ready_for_review: 0,
			accepted: 0,
			cancelled: 0,
		},
		updatedAt: "2025-01-01T00:00:00.000Z",
	},
	{
		id: "mission-2",
		title: "Port command center to a pi extension",
		status: "completed",
		repoPath: "/tmp/cc-port",
		itemCounts: {
			pending: 0,
			in_progress: 0,
			ready_for_review: 0,
			accepted: 2,
			cancelled: 0,
		},
		updatedAt: "2025-01-02T00:00:00.000Z",
	},
]

// ---------------------------------------------------------------------------
// Subcommand position: `/cc <sub-prefix>`
// ---------------------------------------------------------------------------

describe("ccCompletionForCursor — subcommand position", () => {
	test("empty subcommand prefix completes every subcommand", () => {
		const c = ccCompletionForCursor("/cc ", MISSIONS)
		expect(c?.prefix).toBe("")
		expect(c?.items.map((i) => i.value)).toEqual([
			"list",
			"new",
			"launch",
			"resume",
			"abort",
			"delete",
			"attach",
			"accept",
			"reject",
		])
	})

	test("subcommand completion with prefix filters case-insensitively", () => {
		const c = ccCompletionForCursor("/cc AB", MISSIONS)
		expect(c?.prefix).toBe("AB")
		expect(c?.items.map((i) => i.value)).toEqual(["abort"])
	})

	test("subcommand value and label are the name; description is the usage", () => {
		const c = ccCompletionForCursor("/cc attach", MISSIONS)
		expect(c?.items).toEqual([
			{
				value: "attach",
				label: "attach",
				description:
					"Attach to the Mission Lead session: /cc attach <missionId>",
			},
		])
	})

	test("no matching subcommand returns null", () => {
		expect(ccCompletionForCursor("/cc xyz", MISSIONS)).toBeNull()
	})

	test("bare /cc with no space delegates (no completion here)", () => {
		expect(ccCompletionForCursor("/cc", MISSIONS)).toBeNull()
	})
})

// ---------------------------------------------------------------------------
// Mission-id position: `/cc <subcommand> <id-prefix>`
// ---------------------------------------------------------------------------

describe("ccCompletionForCursor — mission id position", () => {
	test("the id prefix is the text to replace, not the whole argument", () => {
		// This is the fix: prefix is "", so applyCompletion keeps `/cc attach `
		// and appends the mission id instead of replacing "attach".
		const c = ccCompletionForCursor("/cc attach ", MISSIONS)
		expect(c?.prefix).toBe("")
		expect(c?.items.map((i) => i.value)).toEqual(MISSIONS.map((m) => m.id))
	})

	test("every mission-id subcommand completes mission ids", () => {
		for (const sub of ["abort", "delete", "attach", "accept", "reject"]) {
			const c = ccCompletionForCursor(`/cc ${sub} `, MISSIONS)
			expect(c?.items.map((i) => i.value)).toEqual(MISSIONS.map((m) => m.id))
		}
	})

	test("value and label are the mission id; description shows title and status", () => {
		const c = ccCompletionForCursor("/cc abort mission-1", MISSIONS)
		expect(c?.prefix).toBe("mission-1")
		expect(c?.items).toEqual([
			{
				value: "mission-1",
				label: "mission-1",
				description: "Extract cc completions · in_progress",
			},
		])
	})

	test("filters by mission id prefix case-insensitively", () => {
		const c = ccCompletionForCursor("/cc abort MISSION-2", MISSIONS)
		expect(c?.prefix).toBe("MISSION-2")
		expect(c?.items.map((i) => i.value)).toEqual(["mission-2"])
	})

	test("filters by title substring case-insensitively", () => {
		// "pi" matches mission-2's title substring (not its id prefix).
		const c = ccCompletionForCursor("/cc attach PI", MISSIONS)
		expect(c?.items.map((i) => i.value)).toEqual(["mission-2"])
	})

	test("empty missions yields null", () => {
		expect(ccCompletionForCursor("/cc abort ", [])).toBeNull()
	})

	test("no mission matches the prefix yields null", () => {
		expect(ccCompletionForCursor("/cc abort nope", MISSIONS)).toBeNull()
	})

	test("list/new/launch/resume do not complete mission ids", () => {
		expect(ccCompletionForCursor("/cc list ", MISSIONS)).toBeNull()
		expect(ccCompletionForCursor("/cc new ", MISSIONS)).toBeNull()
		expect(ccCompletionForCursor("/cc launch ", MISSIONS)).toBeNull()
		expect(ccCompletionForCursor("/cc resume ", MISSIONS)).toBeNull()
	})

	test("extra text after the mission id yields null", () => {
		expect(ccCompletionForCursor("/cc abort mission-1 3", MISSIONS)).toBeNull()
	})

	test("a completed mission-id subcommand re-offers the subcommand (no-op)", () => {
		// `/cc attach` (no space yet) is a subcommand position, not an id one.
		const c = ccCompletionForCursor("/cc attach", MISSIONS)
		expect(c?.items.map((i) => i.value)).toEqual(["attach"])
	})
})

// ---------------------------------------------------------------------------
// Non-/cc text delegates to the built-in provider
// ---------------------------------------------------------------------------

describe("ccCompletionForCursor — passthrough", () => {
	test("plain message text returns null", () => {
		expect(ccCompletionForCursor("fix the typo", MISSIONS)).toBeNull()
	})

	test("a /cc mention inside a sentence returns null", () => {
		expect(
			ccCompletionForCursor("I ran /cc attach earlier", MISSIONS),
		).toBeNull()
	})
})
