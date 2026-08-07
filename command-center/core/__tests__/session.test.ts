import { describe, expect, test } from "bun:test"
import type { AssistantMessage } from "@earendil-works/pi-ai"
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent"
import type { EmittableEvent } from "../events"
import { normalizePiEvent } from "../session"
import type { RoleIdentity } from "../types"

const lead: RoleIdentity = { missionId: "7k3a9fqa", roleName: "mission_lead" }
const owner: RoleIdentity = {
	missionId: "7k3a9fqa",
	roleName: "work_item_owner",
	workItemId: 2,
}
const SESSION_ID = "sess-xyz"

// Cast helper: build a minimal event matching the SDK shape for testing.
function ev(e: unknown): AgentSessionEvent {
	return e as AgentSessionEvent
}

function am(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "hi" }],
		api: "anthropic",
		provider: "anthropic",
		model: "m",
		usage: {} as AssistantMessage["usage"],
		stopReason: "stop",
		timestamp: 0,
	} as AssistantMessage
}

function expectEvent(
	e: EmittableEvent | null,
	type: EmittableEvent["type"],
): EmittableEvent {
	if (e === null) throw new Error(`expected event ${type}, got null`)
	expect(e.type).toBe(type)
	return e
}

// ---------------------------------------------------------------------------
// normalizePiEvent (ticket 01): re-wrap pi SDK session events into the
// library's own vocabulary, identity-stamped with the role.
// ---------------------------------------------------------------------------

describe("normalizePiEvent — deltas", () => {
	test("text_delta → message-delta", () => {
		const e = normalizePiEvent(
			owner,
			SESSION_ID,
			ev({
				type: "message_update",
				assistantMessageEvent: {
					type: "text_delta",
					delta: "hel",
					contentIndex: 0,
				},
			}),
		)
		const out = expectEvent(e, "message-delta")
		expect(out).toMatchObject({
			missionId: "7k3a9fqa",
			roleName: "work_item_owner",
			workItemId: 2,
			delta: "hel",
		})
	})

	test("thinking_delta → reasoning-delta", () => {
		const e = normalizePiEvent(
			lead,
			SESSION_ID,
			ev({
				type: "message_update",
				assistantMessageEvent: {
					type: "thinking_delta",
					delta: "think",
					contentIndex: 0,
				},
			}),
		)
		const out = expectEvent(e, "reasoning-delta")
		expect(out).toMatchObject({ roleName: "mission_lead", delta: "think" })
		expect(out).not.toHaveProperty("workItemId")
	})
})

describe("normalizePiEvent — skipped content-block boundaries", () => {
	// ticket 01: skip pi's content-block ends (text_end/thinking_end) — redundant.
	for (const t of [
		"start",
		"text_start",
		"text_end",
		"thinking_start",
		"thinking_end",
		"toolcall_start",
	]) {
		test(`message_update.${t} → null (skipped)`, () => {
			const e = normalizePiEvent(
				lead,
				SESSION_ID,
				ev({ type: "message_update", assistantMessageEvent: { type: t } }),
			)
			expect(e).toBeNull()
		})
	}
})

describe("normalizePiEvent — tool calls", () => {
	test("tool_execution_start → tool-call-started", () => {
		const e = normalizePiEvent(
			owner,
			SESSION_ID,
			ev({
				type: "tool_execution_start",
				toolCallId: "tc1",
				toolName: "bash",
				args: { command: "ls" },
			}),
		)
		const out = expectEvent(e, "tool-call-started")
		expect(out).toMatchObject({
			toolCallId: "tc1",
			toolName: "bash",
			args: { command: "ls" },
			workItemId: 2,
		})
	})

	test("tool_execution_end → tool-call-ended (carries result + isError)", () => {
		const e = normalizePiEvent(
			owner,
			SESSION_ID,
			ev({
				type: "tool_execution_end",
				toolCallId: "tc1",
				toolName: "bash",
				result: {
					content: [],
					details: { kind: "request_review", summary: "done" },
				},
				isError: false,
			}),
		)
		const out = expectEvent(e, "tool-call-ended")
		expect(out).toMatchObject({
			toolCallId: "tc1",
			toolName: "bash",
			isError: false,
			workItemId: 2,
		})
		expect(out).toHaveProperty("result")
	})
})

describe("normalizePiEvent — message & session boundaries", () => {
	test("message_end (assistant) → message-ended", () => {
		const msg = am()
		const e = normalizePiEvent(
			lead,
			SESSION_ID,
			ev({ type: "message_end", message: msg }),
		)
		const out = expectEvent(e, "message-ended")
		expect(out).toMatchObject({ message: msg, roleName: "mission_lead" })
	})

	test("agent_end → session-ended (turn boundary)", () => {
		const e = normalizePiEvent(
			owner,
			SESSION_ID,
			ev({ type: "agent_end", messages: [], willRetry: false }),
		)
		const out = expectEvent(e, "session-ended")
		expect(out).toMatchObject({
			roleName: "work_item_owner",
			workItemId: 2,
			sessionId: SESSION_ID,
		})
	})

	test("compaction_end → null (not in the 12; handled by re-injection logic)", () => {
		const e = normalizePiEvent(
			lead,
			SESSION_ID,
			ev({
				type: "compaction_end",
				reason: "threshold",
				result: undefined,
				aborted: false,
				willRetry: false,
			}),
		)
		expect(e).toBeNull()
	})

	test("unknown event types → null", () => {
		expect(
			normalizePiEvent(lead, SESSION_ID, ev({ type: "turn_start" })),
		).toBeNull()
		expect(
			normalizePiEvent(
				lead,
				SESSION_ID,
				ev({ type: "queue_update", steering: [], followUp: [] }),
			),
		).toBeNull()
	})
})
