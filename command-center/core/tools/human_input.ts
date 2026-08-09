import { randomBytes } from "node:crypto"
import {
	defineTool,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import type { EventBus } from "../events"
import type { Store } from "../store"
import type { HumanInputRequest, RoleIdentity } from "../types"

const RequestHumanInputSchema = Type.Object({
	question: Type.String({
		description: "The question to ask the human operator.",
	}),
	options: Type.Optional(
		Type.Array(Type.String(), {
			description: "Optional list of choices for the human to pick from.",
		}),
	),
	workItemId: Type.Optional(
		Type.Integer({
			description: "Optional ID of the work item this question relates to.",
		}),
	),
})

/**
 * Creates the `request_human_input` tool for custom/headless lead flows.
 * The Pi extension lead does not include this tool; it asks the attached human
 * in conversation instead. Headless hosts may still use the async inbox seam.
 */
export function createRequestHumanInputTool(
	store: Store,
	bus: EventBus,
	who: RoleIdentity,
): ToolDefinition<typeof RequestHumanInputSchema> {
	return defineTool<typeof RequestHumanInputSchema>({
		name: "request_human_input",
		label: "Request Human Input",
		description:
			"Ask the human operator a question asynchronously. Do not wait for the response in this session; the host will deliver the answer in a future turn once the human replies.",
		parameters: RequestHumanInputSchema,
		execute: async (_toolCallId, args) => {
			const requestId = randomBytes(4).toString("hex")

			const request: HumanInputRequest = {
				requestId,
				missionId: who.missionId,
				workItemId: args.workItemId,
				question: args.question,
				options: args.options,
				status: "open",
				createdAt: new Date().toISOString(),
			}

			await store.writeHumanInputRequest(who.missionId, request)

			bus.emit({
				type: "human-input-requested",
				requestId,
				question: args.question,
				options: args.options,
				missionId: who.missionId,
				roleName: who.roleName,
				workItemId: who.workItemId, // Always lead, but preserving EventRoleRef semantics
			})

			return {
				content: [
					{
						type: "text",
						text: `Request ${requestId} submitted. The host will deliver the answer in a future turn. Continue with other work or end your turn.`,
					},
				],
				details: { requestId },
			}
		},
	})
}
