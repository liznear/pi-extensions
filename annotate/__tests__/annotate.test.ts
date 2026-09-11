import { describe, expect, it } from "bun:test"
import { existsSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SessionEntry } from "@earendil-works/pi-coding-agent"
import {
	extractLastAssistantText,
	resolveRevdiffBin,
	resolveTarget,
} from "../index"

describe("extractLastAssistantText", () => {
	it("returns null when session entries are empty", () => {
		expect(extractLastAssistantText([])).toBeNull()
	})

	it("extracts plain string assistant message", () => {
		const entries = [
			{
				type: "message",
				id: "1",
				parentId: null,
				timestamp: "2026-04-14T00:00:00Z",
				message: { role: "user", content: "hello", timestamp: 1 },
			},
			{
				type: "message",
				id: "2",
				parentId: "1",
				timestamp: "2026-04-14T00:00:01Z",
				message: {
					role: "assistant",
					content: "Here is the response",
					timestamp: 2,
					api: "openai",
					provider: "openai",
					model: "gpt-4",
					usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
					stopReason: "stop",
				},
			},
		] as unknown as SessionEntry[]
		expect(extractLastAssistantText(entries)).toBe("Here is the response")
	})

	it("extracts structured array content from assistant message", () => {
		const entries = [
			{
				type: "message",
				id: "1",
				parentId: null,
				timestamp: "2026-04-14T00:00:00Z",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "part one" },
						{ type: "text", text: "part two" },
					],
					timestamp: 1,
					api: "openai",
					provider: "openai",
					model: "gpt-4",
					usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
					stopReason: "stop",
				},
			},
		] as unknown as SessionEntry[]
		expect(extractLastAssistantText(entries)).toBe("part one\npart two")
	})
})

describe("resolveRevdiffBin", () => {
	it("respects REVDIFF_BIN env override", () => {
		const testBin = join(tmpdir(), "mock-revdiff")
		writeFileSync(testBin, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
		const orig = process.env.REVDIFF_BIN
		try {
			process.env.REVDIFF_BIN = testBin
			expect(resolveRevdiffBin()).toBe(testBin)
		} finally {
			if (orig !== undefined) process.env.REVDIFF_BIN = orig
			else delete process.env.REVDIFF_BIN
		}
	})
})

describe("resolveTarget", () => {
	const mockPi = {} as unknown as Parameters<typeof resolveTarget>[0]

	it("resolves diff HEAD by default", async () => {
		const ctx = { cwd: process.cwd() } as unknown as Parameters<
			typeof resolveTarget
		>[1]
		const res = await resolveTarget(mockPi, ctx, "diff")
		expect(res.ok).toBe(true)
		if (res.ok) {
			expect(res.target.args).toEqual(["HEAD", "--untracked"])
			expect(res.target.label).toBe("git diff")
		}
	})

	it("resolves diff with specific base", async () => {
		const ctx = { cwd: process.cwd() } as unknown as Parameters<
			typeof resolveTarget
		>[1]
		const res = await resolveTarget(mockPi, ctx, "diff main")
		expect(res.ok).toBe(true)
		if (res.ok) {
			expect(res.target.args).toEqual(["main", "--untracked"])
			expect(res.target.label).toBe("git diff main")
		}
	})

	it("resolves existing file with --only", async () => {
		const ctx = { cwd: process.cwd() } as unknown as Parameters<
			typeof resolveTarget
		>[1]
		const res = await resolveTarget(mockPi, ctx, "package.json")
		expect(res.ok).toBe(true)
		if (res.ok) {
			expect(res.target.args[0]).toBe("--only")
			expect(res.target.args[1]).toEndWith("package.json")
		}
	})

	it("fails on non-existent file path", async () => {
		const ctx = { cwd: process.cwd() } as unknown as Parameters<
			typeof resolveTarget
		>[1]
		const res = await resolveTarget(mockPi, ctx, "non-existent-xyz-file.ts")
		expect(res.ok).toBe(false)
		if (!res.ok) {
			expect(res.level).toBe("error")
			expect(res.message).toContain("Path not found")
		}
	})

	it("resolves last message and creates temporary markdown file", async () => {
		const ctx = {
			cwd: process.cwd(),
			sessionManager: {
				getEntries: () => [
					{
						type: "message",
						id: "1",
						parentId: null,
						timestamp: "2026-04-14T00:00:00Z",
						message: {
							role: "assistant",
							content: "Plan content to review",
							timestamp: 1,
						},
					},
				],
			},
		} as unknown as Parameters<typeof resolveTarget>[1]

		const res = await resolveTarget(mockPi, ctx, "last")
		expect(res.ok).toBe(true)
		if (res.ok) {
			expect(res.target.args[0]).toBe("--only")
			const tempFile = res.target.args[1]
			expect(existsSync(tempFile)).toBe(true)
			expect(res.target.cleanupDir).toBeDefined()
		}
	})
})
