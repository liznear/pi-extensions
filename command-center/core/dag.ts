import {
	isTerminalWorkItemStatus,
	type Plan,
	type WorkItem,
	type WorkItemStatus,
} from "./types"

// ---------------------------------------------------------------------------
// DAG scheduling predicates (ticket 05).
//
// All three are pure functions over a Plan — no Store, no side effects. They
// take a `Plan` (not a bare item array) because they answer questions about a
// plan's scheduling state. The Orchestrator recomputes eligibility after any
// terminal transition or queue drain.
//
//   D1 — readiness is *computed*, not stored: a WorkItem is ready when it is
//        `pending` AND every declared dependency is `accepted`. There is no
//        `ready` status; `pending` covers both "deps unsatisfied" and
//        "satisfied, waiting for a dispatch slot."
//   D2 — only `accepted` (terminal success) satisfies a dependency. Never
//        `ready_for_review`. (The load-bearing invariant.)
//   D5 — rollup: mission → ready_for_acceptance when every item is terminal
//        AND ≥1 is accepted. (all-cancelled is degenerate → no rollup.)
//   D8 — liveliness: the mission is stuck when ≥1 item is non-terminal, the
//        ready-set is empty, and nothing is in flight. Catches a pending item
//        depending on a cancelled item, a cyclic plan, or any undrainable plan.
// ---------------------------------------------------------------------------

/** Look up an item's status, or `undefined` if the id doesn't exist (dangling dep). */
function statusOf(
	items: readonly WorkItem[],
	id: number,
): WorkItemStatus | undefined {
	return items.find((it) => it.id === id)?.status
}

/**
 * Compute the ready-set: ids of items that are `pending` and whose every
 * declared dependency is `accepted` (ticket 05 D1/D2). A dangling or
 * cancelled dependency never satisfies. Order is undefined; callers may
 * re-sort deterministically before dispatch.
 */
export function computeReadySet(plan: Plan): number[] {
	const items = plan.items
	return items
		.filter((it) => it.status === "pending")
		.filter((it) =>
			it.dependencies.every((depId) => statusOf(items, depId) === "accepted"),
		)
		.map((it) => it.id)
}

/**
 * Rollup predicate (ticket 05 D5): should the mission move to
 * `ready_for_acceptance`? True when every item is terminal AND at least one
 * is `accepted` (an all-cancelled mission produced nothing → does not roll up).
 */
export function rollupPredicate(plan: Plan): boolean {
	const items = plan.items
	if (items.length === 0) return false
	const allTerminal = items.every((it) => isTerminalWorkItemStatus(it.status))
	if (!allTerminal) return false
	return items.some((it) => it.status === "accepted")
}

/**
 * Stuck predicate (ticket 05 D8): the liveliness guard. True when the plan
 * cannot drain but isn't done — (a) ≥1 non-terminal item, AND (b) the
 * ready-set is empty, AND (c) nothing is in flight (no in_progress,
 * no ready_for_review). Catches a pending item depending on a cancelled item,
 * a cyclic plan, or any undrainable shape.
 *
 * The Orchestrator, on true, proactively resumes the lead session with a
 * re-planning prompt.
 */
export function stuckPredicate(plan: Plan): boolean {
	const items = plan.items
	if (items.length === 0) return false
	const hasNonTerminal = items.some(
		(it) => !isTerminalWorkItemStatus(it.status),
	)
	if (!hasNonTerminal) return false // everything terminal → rolled up or degenerate
	const inFlight = items.some(
		(it) => it.status === "in_progress" || it.status === "ready_for_review",
	)
	if (inFlight) return false
	return computeReadySet(plan).length === 0
}
