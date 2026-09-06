import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { appendReminder, type ChatMessageLike, createTracker } from "../index"

const ENV_VAR = "PI_ANNOUNCE_MODE"
let savedEnv: string | undefined

beforeEach(() => {
	savedEnv = process.env[ENV_VAR]
	delete process.env[ENV_VAR]
})

afterEach(() => {
	if (savedEnv === undefined) delete process.env[ENV_VAR]
	else process.env[ENV_VAR] = savedEnv
})

describe("createTracker", () => {
	test("enforce gates the first tool call of a turn until announce", () => {
		const tracker = createTracker()
		expect(tracker.gateToolCall({ mode: "enforce" })).toMatch(
			/^Gated by announce/,
		)
		tracker.announced()
		expect(tracker.gateToolCall({ mode: "enforce" })).toBeUndefined()
	})

	test("enforce re-gates after maxToolCalls calls without announce", () => {
		const tracker = createTracker()
		tracker.announced()
		const config = { mode: "enforce" as const, maxToolCalls: 2 }
		expect(tracker.gateToolCall(config)).toBeUndefined()
		expect(tracker.gateToolCall(config)).toBeUndefined()
		expect(tracker.gateToolCall(config)).toMatch(/^Gated by announce/)
	})

	test("reset requires a fresh announce for the next turn", () => {
		const tracker = createTracker()
		tracker.announced()
		expect(tracker.gateToolCall({ mode: "enforce" })).toBeUndefined()
		tracker.reset()
		expect(tracker.gateToolCall({ mode: "enforce" })).toMatch(
			/^Gated by announce/,
		)
	})

	test("nag mode never blocks but keeps counting tool calls", () => {
		const tracker = createTracker()
		for (let i = 0; i < 5; i++) {
			expect(tracker.gateToolCall({ mode: "nag" })).toBeUndefined()
		}
		expect(tracker.toolCallsSinceAnnounce).toBe(5)
	})

	test("announce resets the counter", () => {
		const tracker = createTracker()
		tracker.gateToolCall({ mode: "nag" })
		tracker.gateToolCall({ mode: "nag" })
		tracker.announced()
		expect(tracker.toolCallsSinceAnnounce).toBe(0)
	})
})

describe("appendReminder", () => {
	test("appends a reminder part to the last toolResult message", () => {
		const messages: ChatMessageLike[] = [
			{ role: "user", content: "do it" },
			{ role: "toolResult", content: [{ type: "text", text: "out" }] },
		]
		const text = appendReminder(messages, 4)
		expect(text).toContain("4 tool calls")
		const last = messages[1]
		expect(last.content).toHaveLength(2)
		expect(last.content).toEqual([
			{ type: "text", text: "out" },
			{ type: "text", text },
		])
	})

	test("converts string user content into text parts", () => {
		const messages: ChatMessageLike[] = [{ role: "user", content: "hello" }]
		const text = appendReminder(messages, 3)
		expect(messages[0].content).toEqual([
			{ type: "text", text: "hello" },
			{ type: "text", text },
		])
	})

	test("appends after existing user content parts", () => {
		const messages: ChatMessageLike[] = [
			{ role: "user", content: [{ type: "text", text: "a" }] },
		]
		const text = appendReminder(messages, 2)
		expect(messages[0].content).toEqual([
			{ type: "text", text: "a" },
			{ type: "text", text },
		])
	})

	test("returns undefined when the last message is an assistant message", () => {
		const messages: ChatMessageLike[] = [{ role: "assistant", content: [] }]
		expect(appendReminder(messages, 3)).toBeUndefined()
		expect(messages[0].content).toEqual([])
	})

	test("returns undefined for an empty message list", () => {
		expect(appendReminder([], 3)).toBeUndefined()
	})
})
