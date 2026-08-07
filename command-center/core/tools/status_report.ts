import {
	defineTool,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import type { EventBus } from "../events"
import type { Store } from "../store"
import type { RoleIdentity, StatusReport } from "../types"

const ReportStatusSchema = Type.Object({
	summary: Type.String({
		description: "A narrative summary of the mission's status.",
	}),
})

/**
 * Creates the `report_status` tool for the mission lead (ticket 05 / 10).
 * This tool allows the lead to write a narrative status report for the mission.
 * Latest-wins, purely informational, doesn't gate dispatch.
 */
export function createReportStatusTool(
	store: Store,
	bus: EventBus,
	who: RoleIdentity,
): ToolDefinition<typeof ReportStatusSchema> {
	return defineTool<typeof ReportStatusSchema>({
		name: "report_status",
		label: "Report Status",
		description:
			"Report the current status of the mission for human visibility. Provide a brief narrative summary of progress, current focus, and any blockers.",
		parameters: ReportStatusSchema,
		execute: async (_toolCallId, args) => {
			const report: StatusReport = {
				summary: args.summary,
				updatedAt: new Date().toISOString(),
			}

			await store.writeStatusReport(who.missionId, report)

			bus.emit({
				type: "status-reported",
				summary: args.summary,
				missionId: who.missionId,
				roleName: who.roleName,
				workItemId: who.workItemId,
			})

			return {
				content: [{ type: "text", text: "Status reported successfully." }],
				details: {},
			}
		},
	})
}
