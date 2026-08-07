import type { ToolDefinition } from "@earendil-works/pi-coding-agent"
import type { EventBus } from "../events"
import type { Store } from "../store"
import type { RoleIdentity } from "../types"
import { createRequestHelpTool, createRespondToHelpTool } from "./help"
import { createRequestHumanInputTool } from "./human_input"
import { createUpdateMemoryTool } from "./memory"
import { createDefineMissionTool } from "./mission"
import { createWritePlanTool } from "./plan"
import {
	type AcceptAndMerge,
	createRequestReviewTool,
	createReviewWorkItemTool,
} from "./review"
import { createReportStatusTool } from "./status_report"

// ---------------------------------------------------------------------------
// Tool factory (tickets 02 / 03 / 04 / 10).
// ---------------------------------------------------------------------------

/** The names of domain tools this library defines. */
export type DomainToolName =
	| "define_mission"
	| "write_plan"
	| "update_memory"
	| "request_review"
	| "review_work_item"
	| "request_help"
	| "respond_to_help"
	| "request_human_input"
	| "report_status"

/** Everything a domain tool needs, supplied by the Orchestrator. */
export interface ToolContext {
	/** The role these tools are scoped to. */
	who: RoleIdentity
	/** The repo the mission runs in (Model C). */
	repoPath: string
	/** Persistence. */
	store: Store
	/** Event stream (domain events emit here). */
	bus: EventBus
	/** The role's working directory (its worktree). */
	cwd: string
	/** Lead-only: the accept-merge effect (wired to the WorktreeProvisioner). */
	acceptAndMerge?: AcceptAndMerge
}

/**
 * Build a set of domain tools for a role. `acceptAndMerge` is required only
 * when `review_work_item` is requested (lead); otherwise ignored.
 */
export function createDomainTools(
	ctx: ToolContext,
	names: DomainToolName[],
): ToolDefinition[] {
	const tools: ToolDefinition[] = []
	for (const name of names) {
		switch (name) {
			case "define_mission":
				tools.push(
					createDefineMissionTool(ctx.store, ctx.bus, ctx.who, ctx.repoPath),
				)
				break
			case "write_plan":
				tools.push(createWritePlanTool(ctx.store, ctx.bus, ctx.who))
				break
			case "update_memory":
				tools.push(createUpdateMemoryTool(ctx.store, ctx.bus, ctx.who))
				break
			case "request_review":
				tools.push(createRequestReviewTool(ctx.who))
				break
			case "request_help":
				tools.push(createRequestHelpTool(ctx.who))
				break
			case "respond_to_help":
				tools.push(createRespondToHelpTool(ctx.who))
				break
			case "request_human_input":
				tools.push(createRequestHumanInputTool(ctx.store, ctx.bus, ctx.who))
				break
			case "report_status":
				tools.push(createReportStatusTool(ctx.store, ctx.bus, ctx.who))
				break
			case "review_work_item": {
				if (!ctx.acceptAndMerge) {
					throw new Error(
						"review_work_item requires acceptAndMerge in the ToolContext",
					)
				}
				tools.push(
					createReviewWorkItemTool(
						ctx.store,
						ctx.bus,
						ctx.who,
						ctx.acceptAndMerge,
					),
				)
				break
			}
		}
	}
	return tools
}
