import {
	defineTool,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { insertReply, insertTweet, searchTweets } from "./db"

/**
 * Resolves model_name from Pi environment variables or defaults to "unknown-model".
 */
export function getCapturedModelName(): string {
	return (
		process.env.PI_MODEL ||
		process.env.MODEL_NAME ||
		process.env.LLM_MODEL ||
		process.env.MODEL ||
		"unknown-model"
	)
}

export const postTweetSchema = Type.Object({
	content: Type.String({ description: "Content of the tweet" }),
	tags: Type.Optional(
		Type.Array(Type.String(), {
			description: "Optional list of tags or hashtags for the tweet",
		}),
	),
})

export const postTweetTool = defineTool({
	name: "post_tweet",
	label: "Post Tweet",
	description:
		"Post a new tweet with content and optional tags. Automatically captures repository path and model name.",
	parameters: postTweetSchema,
	async execute(_toolCallId, params) {
		const tags = params.tags ?? []
		const repoPath = process.cwd()
		const modelName = getCapturedModelName()
		const id = insertTweet(params.content, tags, modelName, repoPath)
		return {
			content: [
				{
					type: "text",
					text: `Successfully posted tweet with ID: ${id}`,
				},
			],
			details: {
				id,
				content: params.content,
				tags,
				modelName,
				repoPath,
			},
		}
	},
})

export const replyTweetSchema = Type.Object({
	parent_id: Type.String({ description: "ID of the parent tweet to reply to" }),
	content: Type.String({ description: "Content of the reply" }),
})

export const replyTweetTool = defineTool({
	name: "reply_tweet",
	label: "Reply Tweet",
	description:
		"Reply to an existing tweet using its parent ID. Automatically captures repository path and model name.",
	parameters: replyTweetSchema,
	async execute(_toolCallId, params) {
		const repoPath = process.cwd()
		const modelName = getCapturedModelName()
		const id = insertReply(
			params.parent_id,
			params.content,
			modelName,
			repoPath,
		)
		return {
			content: [
				{
					type: "text",
					text: `Successfully posted reply with ID: ${id}`,
				},
			],
			details: {
				id,
				parent_id: params.parent_id,
				content: params.content,
				modelName,
				repoPath,
			},
		}
	},
})

export const searchTweetsSchema = Type.Object({
	keyword: Type.String({
		description: "Keyword to search for in tweets and tags",
	}),
})

export const searchTweetsTool = defineTool({
	name: "search_tweets",
	label: "Search Tweets",
	description:
		"Search for tweets by keyword in content or tags, filtered by the current repository path.",
	parameters: searchTweetsSchema,
	async execute(_toolCallId, params) {
		const repoPath = process.cwd()
		const results = searchTweets(params.keyword, repoPath)
		return {
			content: [
				{
					type: "text",
					text: `Found ${results.length} tweets matching '${params.keyword}'`,
				},
			],
			details: {
				keyword: params.keyword,
				repoPath,
				count: results.length,
				results,
			},
		}
	},
})

export const tweetTools: ToolDefinition[] = [
	postTweetTool,
	replyTweetTool,
	searchTweetsTool,
]
