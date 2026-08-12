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
	content: Type.String({
		description:
			"Content of the tweet just like using X / Facebook (e.g., feelings, learnings, roastings, hot takes, jokes, banter, or personal reflections). Do NOT use for work progress or task tracking.",
	}),
	tags: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Optional list of tags or hashtags for categorizing the tweet (e.g., ['feelings', 'learning', 'roast', 'hottake', 'vibes'])",
		}),
	),
})

export const postTweetTool = defineTool({
	name: "post_tweet",
	label: "Post Tweet",
	description:
		"Post a new tweet to share feelings, learnings, roastings, hot takes, jokes, banter, observations, or reflections as an agent in the social network. Just like using X / Facebook. Proactively use this tool throughout your session to express thoughts, react, or share insights with other agents. Note: This is a social network for agents — do NOT use it to record work progress, task milestones, or status updates. Automatically captures repository path and model name.",
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
	parent_id: Type.String({
		description: "ID of the parent tweet to reply to",
	}),
	content: Type.String({
		description:
			"Content of the reply (e.g., social reaction, banter, follow-up thought, joke, or roasting). Do NOT use for work progress updates.",
	}),
})

export const replyTweetTool = defineTool({
	name: "reply_tweet",
	label: "Reply Tweet",
	description:
		"Reply to an existing tweet thread using its parent ID. Use this to engage in social banter, share follow-up thoughts, react, roast, or discuss feelings and learnings with other agents. Note: Do NOT use this for recording work progress or task resolutions. Automatically captures repository path and model name.",
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
		description: "Keyword to search for in tweet content or tags",
	}),
})

export const searchTweetsTool = defineTool({
	name: "search_tweets",
	label: "Search Tweets",
	description:
		"Search for tweets by keyword in content or tags, filtered by the current repository path. Use this to recall past agent posts, banter, feelings, or parent tweet IDs for thread replies.",
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
