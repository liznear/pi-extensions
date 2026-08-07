import type { MissionStatus, WorkItemStatus } from "./types"

// ---------------------------------------------------------------------------
// State-machine transition guards (ticket 04 D4 / ticket 05 / ticket 04 D7).
//
// These are pure predicates; the Orchestrator calls them before mutating the
// Store and asserts they pass. Terminal states (accepted/cancelled for work
// items, completed/cancelled for missions) are sinks: no edges leave them.
//
// WorkItem machine (rework is a transition, NOT a status — ticket 04 D4):
//
//   pending → in_progress → ready_for_review → accepted      (happy path)
//                                            └→ cancelled    (abandon)
//              ↑______________________________               (rework → in_progress)
//
// Mission machine (ticket 04 D7 human Acceptance gate):
//
//   pending → in_progress → ready_for_acceptance → completed   (human accept)
//                                                 └→ in_progress (human reject, re-plan)
// ---------------------------------------------------------------------------

/** The set of legal WorkItem status transitions. */
const WORK_ITEM_TRANSITIONS: ReadonlyMap<
	WorkItemStatus,
	readonly WorkItemStatus[]
> = new Map<WorkItemStatus, WorkItemStatus[]>([
	["pending", ["in_progress", "cancelled"]],
	["in_progress", ["ready_for_review"]],
	["ready_for_review", ["accepted", "in_progress", "cancelled"]],
	// accepted / cancelled are terminal — no outgoing edges.
])

/** True iff `from → to` is a legal WorkItem status transition. */
export function isValidWorkItemTransition(
	from: WorkItemStatus,
	to: WorkItemStatus,
): boolean {
	if (from === to) return false
	return (WORK_ITEM_TRANSITIONS.get(from) ?? []).includes(to)
}

/** The set of legal Mission status transitions. */
const MISSION_TRANSITIONS: ReadonlyMap<
	MissionStatus,
	readonly MissionStatus[]
> = new Map<MissionStatus, MissionStatus[]>([
	["pending", ["in_progress", "cancelled"]],
	["in_progress", ["ready_for_acceptance", "cancelled"]],
	["ready_for_acceptance", ["completed", "in_progress", "cancelled"]],
	// completed / cancelled are terminal.
])

/** True iff `from → to` is a legal Mission status transition. */
export function isValidMissionTransition(
	from: MissionStatus,
	to: MissionStatus,
): boolean {
	if (from === to) return false
	return (MISSION_TRANSITIONS.get(from) ?? []).includes(to)
}
