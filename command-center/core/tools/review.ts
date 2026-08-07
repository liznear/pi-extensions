import {
	type AgentToolResult,
	defineTool,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent"
import { type Static, Type } from "typebox"
import type { EventBus } from "../events"
import type { Store } from "../store"
import type { RoleIdentity } from "../types"

// ---------------------------------------------------------------------------
// request_review (work_item_owner only — tickets 03 / 04).
//
// The owner's sole channel for what it did: a substantive summary that points
// at files, describes the change, and notes caveats. The Orchestrator
// intercepts the call, transitions the WorkItem to ready_for_review, and
// composes the lead's review input.
//
// `terminate: true` — this is the owner's last action; the session pauses for
// the lead's verdict. The Orchestrator detects the tool result via its details
// and drives the review loop (resume on rework, teardown on accept/cancel).
// ---------------------------------------------------------------------------

const RequestReviewSchema = Type.Object({
	summary: Type.String(),
})

export interface RequestReviewDetails {
	kind: "request_review"
	workItemId: number
	summary: string
}

export function createRequestReviewTool(
	who: RoleIdentity,
): ToolDefinition<typeof RequestReviewSchema> {
	return defineTool<typeof RequestReviewSchema>({
		name: "request_review",
		label: "Request Review",
		description:
			"Signal that this work item is complete and ready for the Mission Lead " +
			"to review. `summary` must be substantive: point at the files you " +
			"changed, describe what the change does, and note any caveats or " +
			"open questions. This is the lead's only view into what you did.",
		parameters: RequestReviewSchema,
		promptGuidelines: [
			"Call request_review only when the work item is genuinely complete and you have verified it.",
			"The summary is the sole channel for what you did — make it substantive, not a one-liner.",
		],
		execute: async (
			_toolCallId: string,
			params: { summary: string },
		): Promise<AgentToolResult<RequestReviewDetails>> => {
			if (who.workItemId === undefined) {
				// Defensive: only an owner can call this. Tool surface prevents it.
				throw new Error("request_review called by a non-owner role")
			}
			return {
				content: [
					{
						type: "text",
						text: "Review requested. The Mission Lead will inspect your work.",
					},
				],
				details: {
					kind: "request_review",
					workItemId: who.workItemId,
					summary: params.summary,
				},
				terminate: true,
			}
		},
	})
}

// ---------------------------------------------------------------------------
// review_work_item (mission_lead only — ticket 04 D4 / D5).
//
// `accept` triggers the Orchestrator-performed merge of the owner's branch into
// the Integration Worktree (ticket 04 D5 / 06 D6). The merge is delegated via
// the `acceptAndMerge` callback the Orchestrator wires in:
//   - Clean merge  → item ready_for_review → accepted.
//   - Conflict     → merge aborted, tool call FAILS (isError:true) naming the
//                    conflicting files; item stays ready_for_review so the lead
//                    can issue `rework` (ticket 05 D4). No transition applied.
// `rework` resumes the owner's session with `feedback` (required) as the prompt.
// `cancel` abandons the item (feedback optional).
// ---------------------------------------------------------------------------

export const ReviewDecisionSchema = Type.Union([
	Type.Literal("accept"),
	Type.Literal("rework"),
	Type.Literal("cancel"),
])

export const ReviewWorkItemSchema = Type.Object({
	workItemId: Type.Integer(),
	decision: ReviewDecisionSchema,
	feedback: Type.Optional(Type.String()),
})
export type ReviewWorkItemInput = Static<typeof ReviewWorkItemSchema>

/** The merge callback the Orchestrator provides for `accept`. */
export type AcceptAndMerge = (
	workItemId: number,
) => Promise<{ ok: true } | { ok: false; conflictingFiles: string[] }>

export interface ReviewWorkItemDetails {
	kind: "review_work_item"
	workItemId: number
	decision: "accept" | "rework" | "cancel"
	applied: boolean
	feedback?: string
}

export function createReviewWorkItemTool(
	store: Store,
	bus: EventBus,
	who: RoleIdentity,
	acceptAndMerge: AcceptAndMerge,
): ToolDefinition<typeof ReviewWorkItemSchema> {
	return defineTool<typeof ReviewWorkItemSchema>({
		name: "review_work_item",
		label: "Review Work Item",
		description:
			"Record your review verdict on a work item.\n" +
			"- `accept`: the work meets criteria; it is merged into integration.\n" +
			"- `rework`: needs changes; `feedback` is REQUIRED and resumes the owner's session.\n" +
			"- `cancel`: abandon (wrong-scoped/obsolete); `feedback` optional.",
		parameters: ReviewWorkItemSchema,
		promptGuidelines: [
			"Inspect the owner's branch against integration (git diff/log) before deciding — do not trust the claim blindly.",
			"On accept conflict, you will be told the conflicting files; issue a `rework` so the owner resolves against integration.",
		],
		execute: async (
			_toolCallId: string,
			params: ReviewWorkItemInput,
		): Promise<AgentToolResult<ReviewWorkItemDetails>> => {
			const { workItemId, decision } = params

			if (decision === "accept") {
				const merge = await acceptAndMerge(workItemId)
				if (!merge.ok) {
					// Conflict: fail the tool call (ticket 05 D4). The runtime marks
					// isError:true; the item stays ready_for_review (no transition).
					// The lead then issues review_work_item(rework, feedback).
					throw new Error(
						`Accept failed: merge conflict in ${merge.conflictingFiles.length} file(s): ` +
							`${merge.conflictingFiles.join(", ")}. The item stays ready_for_review. ` +
							`Issue review_work_item(rework, feedback) so the owner syncs integration and resolves the conflicts.`,
					)
				}
				// Clean merge → accepted.
				await store.writeWorkItemStatus(who.missionId, workItemId, "accepted")
				bus.emit({
					type: "work-item-status-changed",
					missionId: who.missionId,
					workItemId,
					from: "ready_for_review",
					to: "accepted",
					causedBy: { roleName: who.roleName },
				})
				return {
					content: [
						{
							type: "text",
							text: `Work item #${workItemId} accepted and merged into integration.`,
						},
					],
					details: {
						kind: "review_work_item",
						workItemId,
						decision,
						applied: true,
					},
				}
			}

			if (decision === "rework") {
				if (!params.feedback || params.feedback.trim().length === 0) {
					throw new Error(
						"rework requires non-empty `feedback` describing the required changes.",
					)
				}
				await store.writeWorkItemStatus(
					who.missionId,
					workItemId,
					"in_progress",
				)
				bus.emit({
					type: "work-item-status-changed",
					missionId: who.missionId,
					workItemId,
					from: "ready_for_review",
					to: "in_progress",
					causedBy: { roleName: who.roleName },
				})
				return {
					content: [
						{
							type: "text",
							text: `Work item #${workItemId} sent back for rework. Feedback delivered to the owner.`,
						},
					],
					details: {
						kind: "review_work_item",
						workItemId,
						decision,
						applied: true,
						feedback: params.feedback,
					},
				}
			}

			// cancel
			await store.writeWorkItemStatus(who.missionId, workItemId, "cancelled")
			bus.emit({
				type: "work-item-status-changed",
				missionId: who.missionId,
				workItemId,
				from: "ready_for_review",
				to: "cancelled",
				causedBy: { roleName: who.roleName },
			})
			return {
				content: [
					{
						type: "text",
						text: `Work item #${workItemId} cancelled.`,
					},
				],
				details: {
					kind: "review_work_item",
					workItemId,
					decision,
					applied: true,
					feedback: params.feedback,
				},
			}
		},
	})
}
