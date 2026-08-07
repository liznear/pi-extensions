import { describe, expect, test } from "bun:test"
import { computeReadySet, rollupPredicate, stuckPredicate } from "../dag"
import type { Plan, WorkItem } from "../types"

// Helpers ------------------------------------------------------------------

let nextId = 1
function item(over: Partial<WorkItem> & Pick<WorkItem, "title">): WorkItem {
	return {
		id: over.id ?? nextId++,
		title: over.title,
		description: over.description ?? "",
		dependencies: over.dependencies ?? [],
		status: over.status ?? "pending",
	}
}

/** Wrap items into a Plan (the dag functions take a Plan, not a bare array). */
function plan(...items: WorkItem[]): Plan {
	return { items }
}

function resetIds() {
	nextId = 1
}

// ---------------------------------------------------------------------------
// computeReadySet (ticket 05 D1/D2)
//   ready = pending AND every dependency is `accepted`. No "ready" status.
//   Only `accepted` satisfies a dependency (never ready_for_review).
// ---------------------------------------------------------------------------

describe("computeReadySet", () => {
	test("no-dep pending items are all ready (the seeds)", () => {
		resetIds()
		const p = plan(item({ title: "A" }), item({ title: "B" }))
		expect(computeReadySet(p).sort((a, b) => a - b)).toEqual([1, 2])
	})

	test("a dependency in_progress / ready_for_review does NOT satisfy", () => {
		resetIds()
		const p = plan(
			item({ title: "A", status: "in_progress" }),
			item({ title: "B", dependencies: [1] }), // waits on A
			item({ title: "C", status: "ready_for_review" }),
			item({ title: "D", dependencies: [3] }), // waits on C
		)
		// neither B nor D is ready; nothing is pending with all deps accepted
		expect(computeReadySet(p)).toEqual([])
	})

	test("only accepted satisfies a dependency", () => {
		resetIds()
		const p = plan(
			item({ title: "A", status: "accepted" }),
			item({ title: "B", status: "accepted" }),
			item({ title: "C", dependencies: [1, 2] }), // both deps accepted → ready
			item({ title: "D", dependencies: [3] }), // C not yet accepted → not ready
		)
		expect(computeReadySet(p)).toEqual([3])
	})

	test("diamond deps: D waits on BOTH B and C", () => {
		resetIds()
		const items = [
			item({ title: "A", status: "accepted" }),
			item({ title: "B", dependencies: [1], status: "accepted" }),
			item({ title: "C", dependencies: [1], status: "ready_for_review" }),
			item({ title: "D", dependencies: [2, 3] }), // C not accepted yet
		]
		expect(computeReadySet(plan(...items))).toEqual([])
		// once C accepted, D becomes ready
		const c = items[2]
		if (!c) throw new Error("test fixture: missing item C")
		c.status = "accepted"
		expect(computeReadySet(plan(...items))).toEqual([4])
	})

	test("non-pending items are never in the ready-set even if deps met", () => {
		resetIds()
		const p = plan(
			item({ title: "A", status: "accepted" }),
			item({ title: "B", dependencies: [1], status: "in_progress" }),
		)
		expect(computeReadySet(p)).toEqual([])
	})

	test("a dependency on a cancelled item never satisfies", () => {
		resetIds()
		const p = plan(
			item({ title: "A", status: "cancelled" }),
			item({ title: "B", dependencies: [1] }), // can never become ready
		)
		expect(computeReadySet(p)).toEqual([])
	})

	test("dangling dependency (non-existent id) never satisfies", () => {
		resetIds()
		const p = plan(item({ title: "B", dependencies: [999] }))
		expect(computeReadySet(p)).toEqual([])
	})

	test("empty plan → empty ready-set", () => {
		expect(computeReadySet(plan())).toEqual([])
	})
})

// ---------------------------------------------------------------------------
// rollupPredicate (ticket 05 D5)
//   ready_for_acceptance when EVERY item is terminal AND ≥1 is accepted.
//   (all-cancelled is degenerate → does NOT roll up.)
// ---------------------------------------------------------------------------

describe("rollupPredicate", () => {
	test("all accepted → true", () => {
		resetIds()
		expect(
			rollupPredicate(
				plan(
					item({ title: "A", status: "accepted" }),
					item({ title: "B", status: "accepted" }),
				),
			),
		).toBe(true)
	})

	test("mixed accepted+cancelled → true (cancel is a legitimate scoping act)", () => {
		resetIds()
		expect(
			rollupPredicate(
				plan(
					item({ title: "A", status: "accepted" }),
					item({ title: "B", status: "cancelled" }),
				),
			),
		).toBe(true)
	})

	test("any non-terminal item → false", () => {
		resetIds()
		expect(
			rollupPredicate(
				plan(
					item({ title: "A", status: "accepted" }),
					item({ title: "B", status: "in_progress" }),
				),
			),
		).toBe(false)
	})

	test("all cancelled → false (produced nothing; degenerate)", () => {
		resetIds()
		expect(
			rollupPredicate(
				plan(
					item({ title: "A", status: "cancelled" }),
					item({ title: "B", status: "cancelled" }),
				),
			),
		).toBe(false)
	})

	test("empty plan → false (no accepted work)", () => {
		expect(rollupPredicate(plan())).toBe(false)
	})
})

// ---------------------------------------------------------------------------
// stuckPredicate (ticket 05 D8)
//   stuck when (a) ≥1 non-terminal, AND (b) ready-set empty, AND
//   (c) nothing in flight (no in_progress, no ready_for_review).
//   Catches: pending-item-depending-on-cancelled, cycles, any undrainable plan.
// ---------------------------------------------------------------------------

describe("stuckPredicate", () => {
	test("pending item depending on cancelled → stuck", () => {
		resetIds()
		const p = plan(
			item({ title: "A", status: "cancelled" }),
			item({ title: "B", dependencies: [1] }), // pending, dep cancelled
		)
		expect(stuckPredicate(p)).toBe(true)
	})

	test("cycle A↔B (both pending) → stuck", () => {
		resetIds()
		const p = plan(
			item({ title: "A", dependencies: [2] }),
			item({ title: "B", dependencies: [1] }),
		)
		expect(stuckPredicate(p)).toBe(true)
	})

	test("has a ready item → NOT stuck", () => {
		resetIds()
		const p = plan(
			item({ title: "A", status: "accepted" }),
			item({ title: "B", dependencies: [1] }), // ready
		)
		expect(stuckPredicate(p)).toBe(false)
	})

	test("something in flight (in_progress) → NOT stuck", () => {
		resetIds()
		expect(
			stuckPredicate(plan(item({ title: "A", status: "in_progress" }))),
		).toBe(false)
	})

	test("something in flight (ready_for_review) → NOT stuck", () => {
		resetIds()
		expect(
			stuckPredicate(plan(item({ title: "A", status: "ready_for_review" }))),
		).toBe(false)
	})

	test("all terminal, ≥1 accepted → NOT stuck (it's rolled up)", () => {
		resetIds()
		expect(stuckPredicate(plan(item({ title: "A", status: "accepted" })))).toBe(
			false,
		)
	})

	test("all terminal, all cancelled → NOT stuck (degenerate, but not stuck)", () => {
		resetIds()
		expect(
			stuckPredicate(plan(item({ title: "A", status: "cancelled" }))),
		).toBe(false)
	})

	test("empty plan → NOT stuck", () => {
		expect(stuckPredicate(plan())).toBe(false)
	})
})
