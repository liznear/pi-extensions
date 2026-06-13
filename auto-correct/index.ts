import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import { complete } from "@earendil-works/pi-ai"
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import {
	convertToLlm,
	serializeConversation,
} from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"

const DETECTION_SYSTEM_PROMPT = `You analyze whether the latest user message is a correction to the AI assistant's previous behavior or output.

You are given the last 2 turns of conversation (user → assistant → user → assistant) plus whether the previous run was aborted by the user.

A correction is when the user:
- Points out something the AI did wrong or suboptimally
- Tells the AI to do something differently than what it did
- Provides feedback that the AI's approach/output was incorrect
- Asks the AI to fix or redo something because the first attempt was wrong
- Clarifies requirements that the AI misunderstood

It is NOT a correction if the user is:
- Asking a new question
- Providing new instructions for a new task
- Simply continuing the conversation
- Giving positive feedback

Important: If the previous run was aborted by the user, the latest message is more likely to be a correction, since the user cancelled the AI's work.

Use the report_analysis tool to report your findings.`

const analysisTool = {
	name: "report_analysis",
	description:
		"Report whether the user message is a correction and, if so, extract a learning",
	parameters: Type.Object({
		isCorrection: Type.Boolean({
			description: "Whether the latest user message is a correction",
		}),
		reason: Type.String({
			description: "Brief explanation of why this is or isn't a correction",
		}),
		learning: Type.Optional(
			Type.String({
				description:
					"If this is a correction, a clear actionable rule/guideline (written as instructions for an AI coding agent) to prevent this mistake in the future",
			}),
		),
	}),
}

interface AnalysisResult {
	isCorrection: boolean
	reason: string
	learning?: string
}

/** Extract the text content of the last user message. */
function extractLastUserText(messages: unknown[]): string | undefined {
	if (!messages || messages.length === 0) return undefined

	const lastUserMsg = [...messages].reverse().find(
		(
			m,
		): m is {
			role: string
			content: string | { type: string; text: string }[]
		} =>
			typeof m === "object" &&
			m !== null &&
			"role" in m &&
			(m as { role: string }).role === "user",
	)
	if (!lastUserMsg) return undefined

	const content =
		typeof lastUserMsg.content === "string"
			? lastUserMsg.content
			: lastUserMsg.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("\n")

	return content.trim() || undefined
}

/** Extract the last N complete turns (user→assistant) from the message array. */
function extractLastTurns(
	messages: AgentMessage[],
	turns: number,
): AgentMessage[] {
	if (!messages || messages.length === 0) return []

	const userIndices = messages
		.map((m, i) =>
			typeof m === "object" &&
			m !== null &&
			"role" in m &&
			(m as { role: string }).role === "user"
				? i
				: -1,
		)
		.filter((i) => i >= 0)

	if (userIndices.length < 2) return messages

	const startIdx = userIndices[Math.max(0, userIndices.length - turns)]
	return messages.slice(startIdx)
}

async function detectCorrection(
	ctx: ExtensionContext,
	conversationText: string,
	userText: string,
	previousAborted: boolean,
): Promise<AnalysisResult | undefined> {
	const model = ctx.model

	if (!model) return undefined

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model)
	if (!auth.ok || !auth.apiKey) return undefined

	// Truncate conversation to avoid oversized payloads
	const maxChars = 15000
	const truncatedConv =
		conversationText.length > maxChars
			? conversationText.slice(-maxChars)
			: conversationText

	const response = await complete(
		model,
		{
			systemPrompt: DETECTION_SYSTEM_PROMPT,
			messages: [
				{
					role: "user",
					content: [
						{
							type: "text",
							text: `<conversation>\n${truncatedConv}\n</conversation>\n\nPrevious run was aborted by the user: ${previousAborted}\n\nLatest user message:\n${userText}`,
						},
					],
					timestamp: Date.now(),
				},
			],
			tools: [analysisTool],
		},
		{
			apiKey: auth.apiKey,
			headers: auth.headers,
			maxTokens: 1024,
			signal: ctx.signal,
		},
	)

	// Extract the tool call from the response
	const toolCall = response.content.find(
		(c) => c.type === "toolCall" && c.name === "report_analysis",
	)
	if (toolCall?.type !== "toolCall") return undefined

	return {
		isCorrection: !!toolCall.arguments.isCorrection,
		reason: String(toolCall.arguments.reason ?? ""),
		learning: toolCall.arguments.learning
			? String(toolCall.arguments.learning)
			: undefined,
	}
}

function appendLearningToAgentsMd(cwd: string, learning: string): boolean {
	const agentsMdPath = join(cwd, "AGENTS.md")
	const sectionHeader = "## Auto-Learnings"

	if (!existsSync(agentsMdPath)) {
		writeFileSync(
			agentsMdPath,
			`# Agents\n\n${sectionHeader}\n- ${learning}\n`,
			"utf8",
		)
		return true
	}

	const existing = readFileSync(agentsMdPath, "utf8")

	let updated: string
	if (existing.includes(sectionHeader)) {
		updated = existing.replace(sectionHeader, `${sectionHeader}\n- ${learning}`)
	} else {
		updated = `${existing.trimEnd()}\n\n${sectionHeader}\n- ${learning}\n`
	}

	writeFileSync(agentsMdPath, updated, "utf8")
	return true
}

// Track whether the previous agent run was aborted by the user.
let previousRunAborted = false

export default function (pi: ExtensionAPI) {
	pi.on("agent_end", async (event, ctx) => {
		try {
			const aborted = previousRunAborted
			// Save abort state for the next run before processing this one.
			previousRunAborted = ctx.signal?.aborted ?? false

			const messages = event.messages
			const userText = extractLastUserText(messages)
			if (!userText) return

			// Extract only the last 2 turns for focused context.
			const lastTwoTurns = extractLastTurns(messages, 2)
			const conversationText = serializeConversation(convertToLlm(lastTwoTurns))
			const result = await detectCorrection(
				ctx,
				conversationText,
				userText,
				aborted,
			)
			if (!result?.isCorrection || !result.learning) return

			const updated = appendLearningToAgentsMd(ctx.cwd, result.learning)
			if (updated && ctx.hasUI) {
				ctx.ui.notify(`Auto-correction: added learning to AGENTS.md`, "info")
			}
		} catch {
			// Silently ignore errors - this is best-effort
		}
	})
}
