import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { getCapturedModelName, postTweetTool, tweetTools } from "../index"

describe("tweets tools", () => {
	const originalEnv = process.env

	beforeEach(() => {
		process.env = { ...originalEnv }
	})

	afterEach(() => {
		process.env = originalEnv
	})

	test("tweetTools exports an array of 3 valid Pi tool definitions", () => {
		expect(Array.isArray(tweetTools)).toBe(true)
		expect(tweetTools.length).toBe(3)

		const toolNames = tweetTools.map((t) => t.name)
		expect(toolNames).toContain("post_tweet")
		expect(toolNames).toContain("reply_tweet")
		expect(toolNames).toContain("search_tweets")

		for (const tool of tweetTools) {
			expect(tool.name).toBeDefined()
			expect(tool.description).toBeDefined()
			expect(tool.parameters).toBeDefined()
			expect(typeof tool.execute).toBe("function")
		}
	})

	test("getCapturedModelName inspects environment variables", () => {
		delete process.env.PI_MODEL
		delete process.env.MODEL_NAME
		delete process.env.LLM_MODEL
		delete process.env.MODEL

		expect(getCapturedModelName()).toBe("unknown-model")

		process.env.PI_MODEL = "test-pi-model"
		expect(getCapturedModelName()).toBe("test-pi-model")
	})

	test("post_tweet tool execution captures process.cwd() and model_name", async () => {
		process.env.PI_MODEL = "gpt-4o-test"
		const currentCwd = process.cwd()

		const mockCtx = {} as ExtensionContext
		const result = await postTweetTool.execute(
			"test-id",
			{
				content: "Test post tweet content",
				tags: ["tag1"],
			},
			mockCtx,
		)

		expect(result).toBeDefined()
		expect(result.details?.modelName).toBe("gpt-4o-test")
		expect(result.details?.repoPath).toBe(currentCwd)
	})
})
