import { describe, expect, test } from "bun:test"
import type { AssistantMessage } from "@earendil-works/pi-ai"
import type {
	AgentSessionEvent,
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { type EmittableEvent, EventBus } from "../events"
import {
	FakeSessionRunner,
	normalizePiEvent,
	PiVisibleLeadSessionRunner,
} from "../session"
import { InMemoryStore } from "../store"
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

class FakeVisiblePi {
	readonly handlers = new Map<
		string,
		Array<(event: unknown, ctx: ExtensionContext) => unknown>
	>()
	readonly registeredTools: ToolDefinition[] = []
	readonly sent: Array<{
		text: string
		options?: { deliverAs?: "steer" | "followUp" }
	}> = []
	activeTools: string[] = []

	on(
		event: string,
		handler: (event: unknown, ctx: ExtensionContext) => unknown,
	): void {
		const list = this.handlers.get(event) ?? []
		list.push(handler)
		this.handlers.set(event, list)
	}

	registerTool(tool: ToolDefinition): void {
		this.registeredTools.push(tool)
		if (!this.activeTools.includes(tool.name)) this.activeTools.push(tool.name)
	}

	getActiveTools(): string[] {
		return [...this.activeTools]
	}

	setActiveTools(toolNames: string[]): void {
		this.activeTools = [...toolNames]
	}

	sendUserMessage(
		text: string,
		options?: { deliverAs?: "steer" | "followUp" },
	): void {
		this.sent.push({ text, options })
	}

	async emit(
		eventName: string,
		event: unknown,
		ctx: ExtensionContext,
	): Promise<void> {
		for (const handler of this.handlers.get(eventName) ?? []) {
			await handler(event, ctx)
		}
	}
}

function visibleCtx(
	sessionId = "visible-session",
	idle = true,
): ExtensionContext {
	return {
		cwd: "/repo/.command-center/worktrees/7k3a9fqa/integration",
		isIdle: () => idle,
		abort: () => undefined,
		sessionManager: { getSessionId: () => sessionId },
	} as ExtensionContext
}

type VisiblePiApi = Pick<
	ExtensionAPI,
	| "on"
	| "sendUserMessage"
	| "registerTool"
	| "getActiveTools"
	| "setActiveTools"
>

function tool(name: string): ToolDefinition {
	return {
		name,
		label: name,
		description: `${name} description`,
		parameters: Type.Object({}),
		async execute() {
			return {
				content: [{ type: "text", text: `${name} ok` }],
				details: undefined,
			}
		},
	} as ToolDefinition
}

describe("PiVisibleLeadSessionRunner", () => {
	test("uses the current attached lead session for prompts, prompt injection, tools, and events", async () => {
		const bus = new EventBus()
		const store = new InMemoryStore()
		await store.updateMemory(lead, "remember this")
		const pi = new FakeVisiblePi()
		const ctx = visibleCtx()
		const events: EmittableEvent[] = []
		bus.subscribe((e) => events.push(e))
		const runner = new PiVisibleLeadSessionRunner({
			bus,
			store,
			pi: pi as unknown as VisiblePiApi,
			getContext: () => ctx,
			resolveVisibleRole: () => lead,
			hiddenRunner: new FakeSessionRunner(bus),
		})

		const session = await runner.startOrResume(lead, ctx.cwd, "lead prompt", [
			tool("define_mission"),
			tool("read"),
		])
		expect(session.sessionId).toBe("visible-session")
		expect(pi.registeredTools.map((t) => t.name)).toEqual(["define_mission"])
		expect(pi.activeTools).toContain("define_mission")

		const beforeResults = await Promise.all(
			(pi.handlers.get("before_agent_start") ?? []).map((handler) =>
				handler({ type: "before_agent_start" }, ctx),
			),
		)
		expect(beforeResults[0]).toMatchObject({
			systemPrompt: "lead prompt\n\n## Your Memory\n\nremember this",
		})

		const promptDone = session.prompt("review item")
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(pi.sent).toEqual([{ text: "review item", options: undefined }])
		await pi.emit(
			"message_update",
			{
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: "ok" },
			},
			ctx,
		)
		await pi.emit("agent_settled", { type: "agent_settled" }, ctx)
		await promptDone

		expect(events).toContainEqual(
			expect.objectContaining({
				type: "session-started",
				missionId: "7k3a9fqa",
				roleName: "mission_lead",
				sessionId: "visible-session",
			}),
		)
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "message-delta",
				missionId: "7k3a9fqa",
				roleName: "mission_lead",
				delta: "ok",
			}),
		)
	})

	test("bridges visible lead tool results with verdict details", async () => {
		const bus = new EventBus()
		const store = new InMemoryStore()
		const pi = new FakeVisiblePi()
		const ctx = visibleCtx()
		const events: EmittableEvent[] = []
		bus.subscribe((e) => events.push(e))
		const runner = new PiVisibleLeadSessionRunner({
			bus,
			store,
			pi: pi as unknown as VisiblePiApi,
			getContext: () => ctx,
			resolveVisibleRole: () => lead,
			hiddenRunner: new FakeSessionRunner(bus),
		})

		await runner.startOrResume(lead, ctx.cwd, "lead prompt", [
			tool("review_work_item"),
			tool("respond_to_help"),
			tool("write_plan"),
		])

		const reviewToolEnd = {
			type: "tool_execution_end",
			toolCallId: "tc-review",
			toolName: "review_work_item",
			result: {
				details: {
					kind: "review_work_item",
					workItemId: 2,
					decision: "rework",
					applied: true,
					feedback: "tighten tests",
				},
			},
			isError: false,
		}
		await pi.emit("tool_execution_end", reviewToolEnd, ctx)
		await pi.emit("tool_execution_end", reviewToolEnd, ctx)
		await pi.emit(
			"tool_execution_end",
			{
				type: "tool_execution_end",
				toolCallId: "tc-help",
				toolName: "respond_to_help",
				result: {
					details: {
						kind: "respond_to_help",
						workItemId: 2,
						guidance: "sync integration and retry",
					},
				},
				isError: false,
			},
			ctx,
		)
		await pi.emit(
			"tool_execution_end",
			{
				type: "tool_execution_end",
				toolCallId: "tc-plan",
				toolName: "write_plan",
				result: { details: { plan: { items: [] } } },
				isError: false,
			},
			ctx,
		)

		const reviewEvents = events.filter(
			(e) => e.type === "tool-call-ended" && e.toolName === "review_work_item",
		)
		expect(reviewEvents).toHaveLength(1)
		const review = reviewEvents[0]
		expect(review).toMatchObject({
			type: "tool-call-ended",
			missionId: "7k3a9fqa",
			roleName: "mission_lead",
			toolCallId: "tc-review",
		})
		expect(review).not.toHaveProperty("workItemId")
		expect(
			(review as { result?: { details?: { workItemId?: number } } }).result
				?.details?.workItemId,
		).toBe(2)

		const help = events.find(
			(e) => e.type === "tool-call-ended" && e.toolName === "respond_to_help",
		)
		expect(
			(help as { result?: { details?: { workItemId?: number } } }).result
				?.details?.workItemId,
		).toBe(2)
		expect(
			events.some(
				(e) => e.type === "tool-call-ended" && e.toolName === "write_plan",
			),
		).toBe(true)
	})

	test("is inert and falls back to the hidden runner when the current session is not the mission lead", async () => {
		const bus = new EventBus()
		const store = new InMemoryStore()
		const pi = new FakeVisiblePi()
		const hidden = new FakeSessionRunner(bus)
		const ctx = visibleCtx()
		const runner = new PiVisibleLeadSessionRunner({
			bus,
			store,
			pi: pi as unknown as VisiblePiApi,
			getContext: () => ctx,
			resolveVisibleRole: () => undefined,
			hiddenRunner: hidden,
		})

		const session = await runner.startOrResume(lead, ctx.cwd, "lead prompt", [
			tool("define_mission"),
		])
		expect(session.sessionId).toBe("fake-0")
		expect(pi.registeredTools).toEqual([])
		expect(pi.sent).toEqual([])

		const beforeResults = await Promise.all(
			(pi.handlers.get("before_agent_start") ?? []).map((handler) =>
				handler({ type: "before_agent_start" }, ctx),
			),
		)
		expect(beforeResults).toEqual([undefined])
	})

	test("rejects an in-flight visible prompt when the session switches before settling", async () => {
		const bus = new EventBus()
		const store = new InMemoryStore()
		const pi = new FakeVisiblePi()
		const ctx = visibleCtx()
		const runner = new PiVisibleLeadSessionRunner({
			bus,
			store,
			pi: pi as unknown as VisiblePiApi,
			getContext: () => ctx,
			resolveVisibleRole: () => lead,
			hiddenRunner: new FakeSessionRunner(bus),
		})

		const session = await runner.startOrResume(lead, ctx.cwd, "lead prompt", [
			tool("define_mission"),
		])
		const promptDone = session.prompt("review item")
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(pi.sent).toHaveLength(1)

		await pi.emit(
			"session_before_switch",
			{ type: "session_before_switch" },
			ctx,
		)
		await expect(promptDone).rejects.toThrow("session switched")
		expect(pi.activeTools).not.toContain("define_mission")
	})

	test("does not inject or prompt from an acquired handle after a same-role session id change", async () => {
		const bus = new EventBus()
		const store = new InMemoryStore()
		const pi = new FakeVisiblePi()
		const originalCtx = visibleCtx("visible-session-a")
		const replacementCtx = visibleCtx("visible-session-b")
		let currentCtx = originalCtx
		const runner = new PiVisibleLeadSessionRunner({
			bus,
			store,
			pi: pi as unknown as VisiblePiApi,
			getContext: () => currentCtx,
			resolveVisibleRole: () => lead,
			hiddenRunner: new FakeSessionRunner(bus),
		})

		const session = await runner.startOrResume(
			lead,
			originalCtx.cwd,
			"lead prompt",
			[tool("define_mission")],
		)
		currentCtx = replacementCtx

		const beforeResults = await Promise.all(
			(pi.handlers.get("before_agent_start") ?? []).map((handler) =>
				handler({ type: "before_agent_start" }, replacementCtx),
			),
		)
		expect(beforeResults[0]).toBeUndefined()
		await expect(session.prompt("review item")).rejects.toThrow(
			"acquired lead session",
		)
		expect(pi.sent).toEqual([])
	})

	test("owners always use hidden sessions even if the visible session is attached to the lead", async () => {
		const bus = new EventBus()
		const store = new InMemoryStore()
		const pi = new FakeVisiblePi()
		const ctx = visibleCtx()
		const runner = new PiVisibleLeadSessionRunner({
			bus,
			store,
			pi: pi as unknown as VisiblePiApi,
			getContext: () => ctx,
			resolveVisibleRole: () => lead,
			hiddenRunner: new FakeSessionRunner(bus),
		})

		const session = await runner.startOrResume(owner, ctx.cwd, "owner prompt", [
			tool("request_review"),
		])
		expect(session.sessionId).toBe("fake-0")
		expect(pi.registeredTools).toEqual([])
	})
})
