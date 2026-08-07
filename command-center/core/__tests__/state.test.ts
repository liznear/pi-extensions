import { describe, expect, test } from "bun:test"
import { isValidMissionTransition, isValidWorkItemTransition } from "../state"
import type { MissionStatus, WorkItemStatus } from "../types"

// ---------------------------------------------------------------------------
// WorkItemStatus transitions (ticket 04 D4):
//   pending → in_progress → ready_for_review → accepted  (happy path)
//                                            └→ cancelled (abandon)
//              ↑________________________________ (rework loops back to in_progress)
//   accepted / cancelled are terminal (sinks).
// ---------------------------------------------------------------------------

const WORK_ITEM_VALID: Array<[WorkItemStatus, WorkItemStatus]> = [
	["pending", "in_progress"],
	["in_progress", "ready_for_review"],
	["ready_for_review", "accepted"],
	["ready_for_review", "in_progress"], // rework
	["ready_for_review", "cancelled"], // cancel verdict
	["pending", "cancelled"], // lead cancels a not-yet-dispatched / stuck dependent
]

const ALL_WI: WorkItemStatus[] = [
	"pending",
	"in_progress",
	"ready_for_review",
	"accepted",
	"cancelled",
]

describe("isValidWorkItemTransition", () => {
	test("happy path + rework + cancel transitions are valid", () => {
		for (const [from, to] of WORK_ITEM_VALID) {
			expect(isValidWorkItemTransition(from, to)).toBe(true)
		}
	})

	test("same→same is not a transition", () => {
		for (const s of ALL_WI) {
			expect(isValidWorkItemTransition(s, s)).toBe(false)
		}
	})

	test("accepted is terminal (sink) — nothing out", () => {
		for (const to of ALL_WI) {
			expect(isValidWorkItemTransition("accepted", to)).toBe(false)
		}
	})

	test("cancelled is terminal (sink) — nothing out", () => {
		for (const to of ALL_WI) {
			expect(isValidWorkItemTransition("cancelled", to)).toBe(false)
		}
	})

	test("reverse/illegal edges are rejected", () => {
		// can't jump straight from pending to accepted/ready_for_review
		expect(isValidWorkItemTransition("pending", "ready_for_review")).toBe(false)
		expect(isValidWorkItemTransition("pending", "accepted")).toBe(false)
		// can't go backwards except the documented rework edge
		expect(isValidWorkItemTransition("in_progress", "pending")).toBe(false)
		expect(isValidWorkItemTransition("accepted", "ready_for_review")).toBe(
			false,
		)
		// can't dispatch an item already in flight / terminal
		expect(isValidWorkItemTransition("ready_for_review", "pending")).toBe(false)
		expect(isValidWorkItemTransition("in_progress", "cancelled")).toBe(false)
	})
})

// ---------------------------------------------------------------------------
// MissionStatus transitions (tickets 01 / 04 D7):
//   pending → in_progress → ready_for_acceptance → completed (human accept)
//                                              └→ in_progress (human reject, re-plan)
//   completed / cancelled are terminal.
// ---------------------------------------------------------------------------

const MISSION_VALID: Array<[MissionStatus, MissionStatus]> = [
	["pending", "in_progress"],
	["in_progress", "ready_for_acceptance"], // rollup
	["ready_for_acceptance", "completed"], // human accept
	["ready_for_acceptance", "in_progress"], // human reject → re-plan
	["in_progress", "cancelled"],
	["ready_for_acceptance", "cancelled"],
	["pending", "cancelled"],
]

const ALL_MISSION: MissionStatus[] = [
	"pending",
	"in_progress",
	"ready_for_acceptance",
	"completed",
	"cancelled",
]

describe("isValidMissionTransition", () => {
	test("documented mission transitions are valid", () => {
		for (const [from, to] of MISSION_VALID) {
			expect(isValidMissionTransition(from, to)).toBe(true)
		}
	})

	test("same→same is not a transition", () => {
		for (const s of ALL_MISSION) {
			expect(isValidMissionTransition(s, s)).toBe(false)
		}
	})

	test("completed is terminal — nothing out", () => {
		for (const to of ALL_MISSION) {
			expect(isValidMissionTransition("completed", to)).toBe(false)
		}
	})

	test("cancelled is terminal — nothing out", () => {
		for (const to of ALL_MISSION) {
			expect(isValidMissionTransition("cancelled", to)).toBe(false)
		}
	})
})
