import {
	type AgentToolResult,
	defineTool,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent"
import { type Static, Type } from "typebox"
import type { RoleIdentity } from "../types"

// ---------------------------------------------------------------------------
// request_help (work_item_owner only — ticket 13 / 09).
//
// An owner's signal asking the lead for guidance, distinct from request_review.
// The Orchestrator intercepts the call (terminate: true) and drives a triage
// turn for the lead.
// ---------------------------------------------------------------------------

const RequestHelpSchema = Type.Object({
	reason: Type.String(),
})

export interface RequestHelpDetails {
	kind: "request_help"
	workItemId: number
	reason: string
}

export function createRequestHelpTool(
	who: RoleIdentity,
): ToolDefinition<typeof RequestHelpSchema> {
	return defineTool<typeof RequestHelpSchema>({
		name: "request_help",
		label: "Request Help",
		description:
			"Ask the Mission Lead for guidance if you are blocked or need clarification. " +
			"`reason` should explain what is blocking you and what you need from the lead. " +
			"This is distinct from request_review — use this when you cannot proceed.",
		parameters: RequestHelpSchema,
		promptGuidelines: [
			"Call request_help only when genuinely blocked and in need of the lead's guidance.",
			"Do not use this to request a review of completed work.",
		],
		execute: async (
			_toolCallId: string,
			params: { reason: string },
		): Promise<AgentToolResult<RequestHelpDetails>> => {
			if (who.workItemId === undefined) {
				throw new Error("request_help called by a non-owner role")
			}
			return {
				content: [
					{
						type: "text",
						text: "Help requested. The Mission Lead will review your request and provide guidance.",
					},
				],
				details: {
					kind: "request_help",
					workItemId: who.workItemId,
					reason: params.reason,
				},
				terminate: true,
			}
		},
	})
}

// ---------------------------------------------------------------------------
// respond_to_help (mission_lead only — ticket 13 / 09).
//
// The lead's structured close of a triage turn. Returns guidance to the owner.
// ---------------------------------------------------------------------------

export const RespondToHelpSchema = Type.Object({
	workItemId: Type.Integer(),
	guidance: Type.String(),
})
export type RespondToHelpInput = Static<typeof RespondToHelpSchema>

export interface RespondToHelpDetails {
	kind: "respond_to_help"
	workItemId: number
	guidance: string
}

export function createRespondToHelpTool(
	_who: RoleIdentity,
): ToolDefinition<typeof RespondToHelpSchema> {
	return defineTool<typeof RespondToHelpSchema>({
		name: "respond_to_help",
		label: "Respond To Help Request",
		description:
			"Provide guidance to an owner who requested help via `request_help`.",
		parameters: RespondToHelpSchema,
		promptGuidelines: [
			"Provide clear, actionable guidance to unblock the owner.",
		],
		execute: async (
			_toolCallId: string,
			params: RespondToHelpInput,
		): Promise<AgentToolResult<RespondToHelpDetails>> => {
			const { workItemId, guidance } = params

			// Note: The Orchestrator handles the actual routing back to the owner.
			// This tool just signals the end of the triage turn with the guidance.

			return {
				content: [
					{
						type: "text",
						text: `Guidance sent to owner of work item #${workItemId}.`,
					},
				],
				details: {
					kind: "respond_to_help",
					workItemId,
					guidance,
				},
				terminate: true,
			}
		},
	})
}
