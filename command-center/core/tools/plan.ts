import {
	type AgentToolResult,
	defineTool,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent"
import { type Static, Type } from "typebox"
import type { EventBus } from "../events"
import type { Store } from "../store"
import {
	isTerminalWorkItemStatus,
	type Plan,
	type RoleIdentity,
	type WorkItem,
} from "../types"

// ---------------------------------------------------------------------------
// write_plan input (ticket 05 D6).
//
// The agent supplies items WITHOUT `status` (status is managed by the
// Orchestrator via state-machine transitions, never by write_plan). `id` is
// OPTIONAL: omit it to append a new item; provide it to edit an existing one.
// The Plan is append-only — items are never deleted.
// ---------------------------------------------------------------------------

export const WorkItemInputSchema = Type.Object({
	id: Type.Optional(Type.Integer()),
	title: Type.String({
		description:
			"A short work-item title (a label, not a sentence). " +
			"Aim for <= 50 characters, like a git commit subject line.",
	}),
	description: Type.String(),
	dependencies: Type.Array(Type.Integer()),
})
export type WorkItemInput = Static<typeof WorkItemInputSchema>

export const WritePlanInputSchema = Type.Object({
	items: Type.Array(WorkItemInputSchema),
})
export type WritePlanInput = Static<typeof WritePlanInputSchema>

/**
 * Merge a write_plan input into the current Plan (ticket 05 D6 — pure seam).
 *
 * - New items (id absent, or id not in current) are appended with the next
 *   sequential id and status `pending`.
 * - Existing non-terminal items: title/description/deps are editable.
 * - Existing terminal items (accepted/cancelled): title/description editable,
 *   but dependency edges are FROZEN (kept from current).
 * - Items in current but absent from input are RETAINED (never deleted).
 * - An existing item's status is always preserved (write_plan never manages it).
 */
export function mergePlan(current: Plan | null, input: WritePlanInput): Plan {
	const items: WorkItem[] = current
		? current.items.map((it) => ({ ...it }))
		: []
	const existing = new Map(items.map((it) => [it.id, it]))
	const nextId = items.reduce((max, it) => Math.max(max, it.id), 0) + 1
	const errors: string[] = []

	// Validate omissions (deletion attempt)
	const inputIds = new Set(
		input.items.map((it) => it.id).filter((id) => id !== undefined),
	)
	for (const id of existing.keys()) {
		if (!inputIds.has(id)) {
			errors.push(
				`Item ${id} is missing from the input. The plan is append-only; items cannot be deleted. Please include all existing items.`,
			)
		}
	}

	for (const inputItem of input.items) {
		const hit =
			inputItem.id !== undefined ? existing.get(inputItem.id) : undefined
		if (hit) {
			// Edit existing.
			hit.title = inputItem.title
			hit.description = inputItem.description
			// Dependency edges frozen on terminal items (ticket 05 D6).
			if (isTerminalWorkItemStatus(hit.status)) {
				const currentDeps = [...hit.dependencies].sort().join(",")
				const newDeps = [...inputItem.dependencies].sort().join(",")
				if (currentDeps !== newDeps) {
					errors.push(
						`Cannot modify dependencies of item ${hit.id} because its status is '${hit.status}'.`,
					)
				}
			} else {
				hit.dependencies = [...inputItem.dependencies]
			}
			// status always preserved.
		} else {
			if (inputItem.id !== undefined) {
				errors.push(
					`Cannot edit item ${inputItem.id} because it does not exist. Omit the 'id' field to append a new item.`,
				)
			} else {
				// Append new: assign the smallest free id >= nextId.
				const newId = freeId(items, nextId)
				const created: WorkItem = {
					id: newId,
					title: inputItem.title,
					description: inputItem.description,
					dependencies: [...inputItem.dependencies],
					status: "pending",
				}
				items.push(created)
				existing.set(newId, created)
			}
		}
	}

	if (errors.length > 0) {
		throw new Error(`Invalid plan modification:\n- ${errors.join("\n- ")}`)
	}

	return { items }
}

/** Smallest integer >= start not already used by an existing item id. */
function freeId(items: WorkItem[], start: number): number {
	const used = new Set(items.map((it) => it.id))
	let id = start
	while (used.has(id)) id++
	return id
}

// ---------------------------------------------------------------------------
// The write_plan tool (mission_lead only).
// ---------------------------------------------------------------------------

export function createWritePlanTool(
	store: Store,
	bus: EventBus,
	who: RoleIdentity,
): ToolDefinition<typeof WritePlanInputSchema> {
	return defineTool<typeof WritePlanInputSchema>({
		name: "write_plan",
		label: "Write Plan",
		description:
			"Add new work items to the plan and/or edit existing ones. Items are " +
			"append-only (never deleted). Omit `id` to append a new item; provide " +
			"an existing `id` to edit its title/description/dependencies. " +
			"Dependencies of accepted/cancelled items cannot be changed. Each " +
			"description must specify the deliverable/scope, inputs and dependencies, " +
			"observable acceptance criteria, validation evidence, and clean committed " +
			"handoff requirements; explicitly mark no-code items.",
		parameters: WritePlanInputSchema,
		promptGuidelines: [
			"Write descriptions as executable contracts: deliverable, files/scope, inputs/dependencies, measurable criteria, validation commands/evidence, and definition of done.",
			"Use dependencies to serialize work whose outputs form a contract; do not create parallel items that can silently disagree.",
			"Avoid vague criteria such as 'improve' or 'handle' without an observable result.",
		],
		execute: async (
			_toolCallId: string,
			params: WritePlanInput,
		): Promise<AgentToolResult<{ plan: Plan }>> => {
			const current = await store.readPlan(who.missionId)
			const merged = mergePlan(current, params)
			await store.writePlan(who.missionId, merged)

			const mission = await store.readMission(who.missionId)
			if (mission && mission.rejectionFeedback !== undefined) {
				await store.writeMission({ ...mission, rejectionFeedback: undefined })
			}

			bus.emit({ type: "plan-written", missionId: who.missionId, plan: merged })
			return {
				content: [
					{
						type: "text",
						text: `Plan updated. ${merged.items.length} item(s) total.`,
					},
				],
				details: { plan: merged },
			}
		},
	})
}
