import { insertReply, insertTweet, searchTweets } from "./db"

async function run() {
	const repoPath = "/dummy/repo/path"

	console.log("Inserting a tweet...")
	const tweetId = insertTweet(
		"Hello world! This is a test tweet about bun and sqlite.",
		["bun", "sqlite", "test"],
		"gpt-4",
		repoPath,
	)
	console.log("Tweet inserted with ID:", tweetId)

	console.log("Inserting a reply...")
	const replyId = insertReply(
		tweetId,
		"This is a reply to the test tweet! Adding some more content about sqlite.",
		"gpt-4",
		repoPath,
	)
	console.log("Reply inserted with ID:", replyId)

	console.log("Searching tweets for keyword 'sqlite'...")
	const results = searchTweets("sqlite", repoPath)
	console.log(`Found ${results.length} results:`)
	for (const row of results) {
		console.log(`- [${row.id}] (parent: ${row.parent_id}) ${row.content}`)
	}
}

run().catch(console.error)
