import { type Static, Type } from "typebox"

// ---------------------------------------------------------------------------
// Status enums
//
// Underscore-cased throughout (the design docs are inconsistent on
// mission status dashes vs. work-item underscores; we standardize on
// underscores as identifier-friendly values).
// ---------------------------------------------------------------------------

/** A Work Item's lifecycle state (tickets 04 D4 / 05). */
export const WorkItemStatusSchema = Type.Enum([
	"pending",
	"in_progress",
	"ready_for_review",
	"accepted",
	"cancelled",
])
export type WorkItemStatus = Static<typeof WorkItemStatusSchema>

/**
 * `accepted` and `cancelled` are terminal (sinks). `pending` is the only
 * dispatch-eligible state; "ready" is *computed*, never stored (ticket 05 D1).
 */
export const TERMINAL_WORK_ITEM_STATUSES: readonly WorkItemStatus[] = [
	"accepted",
	"cancelled",
] as const
export function isTerminalWorkItemStatus(s: WorkItemStatus): boolean {
	return (TERMINAL_WORK_ITEM_STATUSES as readonly string[]).includes(s)
}

/** A Mission's lifecycle state (tickets 01 / 04 D7). */
export const MissionStatusSchema = Type.Enum([
	"pending",
	"in_progress",
	"ready_for_acceptance",
	"completed",
	"cancelled",
])
export type MissionStatus = Static<typeof MissionStatusSchema>

export const TERMINAL_MISSION_STATUSES: readonly MissionStatus[] = [
	"completed",
	"cancelled",
] as const
export function isTerminalMissionStatus(s: MissionStatus): boolean {
	return (TERMINAL_MISSION_STATUSES as readonly string[]).includes(s)
}

// ---------------------------------------------------------------------------
// Plan / Work Item / Mission
// ---------------------------------------------------------------------------

/**
 * A single node in a Plan's DAG. `id` is permanent and stable (ticket 05 D6:
 * the Plan is append-only for items — items are never deleted). `status`
 * transitions along the state machine; `accepted`/`cancelled` are terminal.
 */
export const WorkItemSchema = Type.Object({
	id: Type.Integer(),
	title: Type.String(),
	description: Type.String(),
	dependencies: Type.Array(Type.Integer()),
	status: WorkItemStatusSchema,
})
export type WorkItem = Static<typeof WorkItemSchema>

/** A DAG of Work Items for one Mission (ticket: Plan). */
export const PlanSchema = Type.Object({
	items: Type.Array(WorkItemSchema),
})
export type Plan = Static<typeof PlanSchema>

/**
 * The top-level unit of work. `id` is an immutable 8-char base36 slug
 * generated at mission start (ticket 06 D2) — backs both the git worktree
 * namespace and event identity. `title` is the mutable human-facing label.
 *
 * `repoPath` is the repo the mission runs in (Model C: one Orchestrator,
 * many missions across many repos). Immutable for a mission's lifetime — the
 * git worktree namespace lives under `<repoPath>/.command-center/`.
 */
export const MissionSchema = Type.Object({
	id: Type.String(),
	repoPath: Type.String(),
	title: Type.String(),
	description: Type.String(),
	acceptanceCriteria: Type.Array(Type.String()),
	status: MissionStatusSchema,
	/**
	 * Captured feedback when the human rejects the mission at the Acceptance gate.
	 * Gates the rollup to ready_for_acceptance until the lead re-plans to address it.
	 */
	rejectionFeedback: Type.Optional(Type.String()),
})
export type Mission = Static<typeof MissionSchema>

// ---------------------------------------------------------------------------
// Human Input & Status (tickets 04 / 05 / 10)
// ---------------------------------------------------------------------------

export const HumanInputRequestStatusSchema = Type.Enum(["open", "answered"])
export type HumanInputRequestStatus = Static<
	typeof HumanInputRequestStatusSchema
>

export const HumanInputRequestSchema = Type.Object({
	requestId: Type.String(),
	missionId: Type.String(),
	workItemId: Type.Optional(Type.Integer()),
	question: Type.String(),
	options: Type.Optional(Type.Array(Type.String())),
	status: HumanInputRequestStatusSchema,
	reply: Type.Optional(Type.String()),
	createdAt: Type.String(),
})
export type HumanInputRequest = Static<typeof HumanInputRequestSchema>

export const StatusReportSchema = Type.Object({
	summary: Type.String(),
	updatedAt: Type.String(),
})
export type StatusReport = Static<typeof StatusReportSchema>

// ---------------------------------------------------------------------------
// Listing summary (ticket 08)
// ---------------------------------------------------------------------------

/** Per-status counts of a mission's work items (ticket 08 — listing summary). */
export interface WorkItemCounts {
	pending: number
	in_progress: number
	ready_for_review: number
	accepted: number
	cancelled: number
}

/** Tally a plan's items into per-status counts (ticket 08). */
export function summarizeWorkItems(items: readonly WorkItem[]): WorkItemCounts {
	const counts: WorkItemCounts = {
		pending: 0,
		in_progress: 0,
		ready_for_review: 0,
		accepted: 0,
		cancelled: 0,
	}
	for (const it of items) counts[it.status] += 1
	return counts
}

/**
 * A read-only summary row for a mission (ticket 08). Derived from persisted
 * Mission + Plan — what a listing surface (e.g. a GUI home) renders per
 * mission, not the full Plan. `itemCounts` are zero across the board when the
 * mission has no Plan yet (stubbed but not planned — ties into ticket 11).
 * `updatedAt` is a Store-tracked ISO timestamp of the last mission.json write
 * (a persistence/audit concern, NOT a field on the Mission domain type).
 */
export interface MissionSummary {
	id: string
	title: string
	status: MissionStatus
	repoPath: string
	itemCounts: WorkItemCounts
	updatedAt: string
}

// ---------------------------------------------------------------------------
// Role identity
// ---------------------------------------------------------------------------

/** The two role profiles in the slice (tickets 02 / 03 / 04). */
export type RoleName = "mission_lead" | "work_item_owner"

/**
 * Structured identity for a Role instance (ticket 02). `workItemId` absent ⇒
 * the mission lead; present ⇒ the owner of that item. Exact for the slice
 * (one lead per mission, one owner per (mission, work item)). Events carry no
 * `roleId` — they thread `roleName` + `workItemId?` directly (ticket 01).
 */
export interface RoleIdentity {
	missionId: string
	roleName: RoleName
	workItemId?: number
}
