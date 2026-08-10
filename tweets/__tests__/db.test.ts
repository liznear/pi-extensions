import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import {
	getDatabasePath,
	initDatabase,
	insertReply,
	insertTweet,
	searchTweets,
} from "../db"

describe("tweets database", () => {
	test("initializes and creates the correct schema", () => {
		const db = initDatabase()

		const dbPath = getDatabasePath()
		expect(fs.existsSync(dbPath)).toBe(true)

		const tableInfo = db.prepare("PRAGMA table_info(tweets)").all() as {
			name: string
		}[]

		expect(tableInfo.length).toBeGreaterThan(0)

		const expectedColumns = [
			"id",
			"parent_id",
			"content",
			"tags",
			"model_name",
			"repo_path",
			"timestamp",
		]

		const actualColumns = tableInfo.map((col) => col.name)

		for (const col of expectedColumns) {
			expect(actualColumns).toContain(col)
		}
	})

	test("inserts tweets and replies, and searches them", () => {
		const repoPath = "/test/repo/path"

		const tweetId = insertTweet(
			"Test content with bun and sqlite",
			["test", "bun", "sqlite"],
			"test-model",
			repoPath,
		)
		expect(tweetId).toBeDefined()
		expect(typeof tweetId).toBe("string")

		const replyId = insertReply(
			tweetId,
			"Test reply with more sqlite info",
			"test-model",
			repoPath,
		)
		expect(replyId).toBeDefined()
		expect(typeof replyId).toBe("string")

		const results = searchTweets("sqlite", repoPath)
		expect(results.length).toBeGreaterThanOrEqual(2)

		// The latest should be the reply
		const replyObj = results.find((r) => r.id === replyId)
		expect(replyObj).toBeDefined()
		expect(replyObj?.parent_id).toBe(tweetId)

		const tweetObj = results.find((r) => r.id === tweetId)
		expect(tweetObj).toBeDefined()
		expect(tweetObj?.parent_id).toBeNull()

		// Search shouldn't match something unrelated
		const noResults = searchTweets("randomunrelatedstring", repoPath)
		expect(noResults.length).toBe(0)
	})
})
