import {
	type AgentToolResult,
	defineTool,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import type { EventBus } from "../events"
import type { Store } from "../store"
import type { RoleIdentity } from "../types"

// ---------------------------------------------------------------------------
// updateMemory (ticket 02) — the agent-facing memory tool.
//
// One param: `content` (the full new markdown doc). The agent curates its own
// memory: it reads the whole doc in context and writes it whole (a full
// REPLACE of the role's single doc). The role's identity is closed over by the
// Orchestrator when building the tool — the agent never knows its own id.
//
// Emits `memory-updated` carrying the full new content (per-role docs are
// small in the slice, so the stream stays self-contained).
// ---------------------------------------------------------------------------

const UpdateMemorySchema = Type.Object({
	content: Type.String(),
})

export function createUpdateMemoryTool(
	store: Store,
	bus: EventBus,
	who: RoleIdentity,
): ToolDefinition<typeof UpdateMemorySchema> {
	return defineTool<typeof UpdateMemorySchema>({
		name: "update_memory",
		label: "Update Memory",
		description:
			"Replace your private memory document (markdown) with the given content. " +
			"This is a full replace — write the whole document, not a delta. Your " +
			"memory is auto-injected at session start; use this to persist notes, " +
			"decisions, and context you want to survive across sessions.",
		parameters: UpdateMemorySchema,
		execute: async (
			_toolCallId: string,
			params: { content: string },
		): Promise<AgentToolResult<unknown>> => {
			await store.updateMemory(who, params.content)
			bus.emit({
				type: "memory-updated",
				missionId: who.missionId,
				roleName: who.roleName,
				workItemId: who.workItemId,
				content: params.content,
			})
			return {
				content: [
					{
						type: "text",
						text: `Memory updated (${params.content.length} chars).`,
					},
				],
				details: {},
			}
		},
	})
}
