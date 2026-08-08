import { basename } from "node:path"
import {
	buildSessionContext,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"

function formatCount(n: number): string {
	if (n < 1_000) return `${n}`
	if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}K`
	return `${(n / 1_000_000).toFixed(1)}M`
}

function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000))
	const hours = Math.floor(totalSeconds / 3600)
	const minutes = Math.floor((totalSeconds % 3600) / 60)
	const seconds = totalSeconds % 60

	if (hours > 0) return `${hours}h${minutes}m${seconds}s`
	if (minutes > 0) return `${minutes}m${seconds}s`
	return `${seconds}s`
}

type TokenCategory =
	| "system"
	| "user"
	| "assistantThinking"
	| "assistantMessage"
	| "tool"

type TokenSegment = {
	category: TokenCategory
	tokens: number
}

type TextContentBlock = { type: "text"; text?: string }
type ImageContentBlock = { type: "image"; data?: string }
type AssistantContentBlock =
	| TextContentBlock
	| { type: "thinking"; thinking?: string }
	| { type: "toolCall"; name?: string; arguments?: unknown }
type TokenUsage = {
	input: number
	output: number
	cacheRead: number
	cacheWrite: number
	totalTokens: number
}
type TokenMessage = {
	role: string
	content?: string | Array<TextContentBlock | ImageContentBlock>
	command?: string
	output?: string
	summary?: string
	usage?: TokenUsage
	stopReason?: string
}
type AssistantTokenMessage = TokenMessage & {
	content: AssistantContentBlock[]
}

const PROGRESS_BAR_WIDTH = 20
const TOKEN_CHARS_PER_TOKEN = 4
const ANSI_RESET = "\x1b[0m"
const ANSI_LIGHT_YELLOW = "\x1b[93m"

function estimateTokensFromChars(chars: number): number {
	return Math.ceil(chars / TOKEN_CHARS_PER_TOKEN)
}

function estimateTextBlocksTokens(
	content: string | Array<TextContentBlock | ImageContentBlock> | undefined,
): number {
	if (!content) return 0
	if (typeof content === "string") {
		return estimateTokensFromChars(content.length)
	}

	let chars = 0
	for (const block of content) {
		if (block.type === "text" && block.text) chars += block.text.length
		if (block.type === "image") chars += 4800
	}
	return estimateTokensFromChars(chars)
}

function calculateContextTokens(usage: TokenUsage): number {
	return (
		usage.totalTokens ||
		usage.input + usage.output + usage.cacheRead + usage.cacheWrite
	)
}

function addTokens(
	segments: TokenSegment[],
	category: TokenCategory,
	tokens: number,
): void {
	if (tokens <= 0) return

	const previous = segments.at(-1)
	if (previous?.category === category) {
		previous.tokens += tokens
		return
	}

	segments.push({ category, tokens })
}

function estimateAssistantSegments(
	message: AssistantTokenMessage,
): TokenSegment[] {
	const segments: TokenSegment[] = []

	for (const block of message.content) {
		if (block.type === "text") {
			addTokens(
				segments,
				"assistantMessage",
				estimateTokensFromChars(block.text?.length ?? 0),
			)
		} else if (block.type === "thinking") {
			addTokens(
				segments,
				"assistantThinking",
				estimateTokensFromChars(block.thinking?.length ?? 0),
			)
		} else if (block.type === "toolCall") {
			addTokens(
				segments,
				"tool",
				estimateTokensFromChars(
					(block.name?.length ?? 0) +
						JSON.stringify(block.arguments ?? {}).length,
				),
			)
		}
	}

	return segments
}

function scaleSegments(
	segments: TokenSegment[],
	targetTokens: number,
): TokenSegment[] {
	const currentTokens = segments.reduce(
		(sum, segment) => sum + segment.tokens,
		0,
	)
	if (currentTokens <= 0 || targetTokens <= 0) return []

	const scaled: TokenSegment[] = []
	let remainingTokens = targetTokens
	for (let i = 0; i < segments.length; i++) {
		const segment = segments[i]
		const tokens =
			i === segments.length - 1
				? remainingTokens
				: Math.min(
						remainingTokens,
						Math.round((targetTokens * segment.tokens) / currentTokens),
					)
		addTokens(scaled, segment.category, tokens)
		remainingTokens -= tokens
	}

	return scaled
}

function estimateMessageSegments(message: TokenMessage): TokenSegment[] {
	switch (message.role) {
		case "user":
			return [
				{
					category: "user",
					tokens: estimateTextBlocksTokens(message.content),
				},
			]
		case "assistant":
			if (!Array.isArray(message.content)) return []
			return estimateAssistantSegments(message as AssistantTokenMessage)
		case "toolResult":
		case "custom":
			return [
				{
					category: "tool",
					tokens: estimateTextBlocksTokens(message.content),
				},
			]
		case "bashExecution":
			return [
				{
					category: "tool",
					tokens: estimateTokensFromChars(
						(message.command?.length ?? 0) + (message.output?.length ?? 0),
					),
				},
			]
		case "branchSummary":
		case "compactionSummary":
			return [
				{
					category: "system",
					tokens: estimateTokensFromChars(message.summary?.length ?? 0),
				},
			]
		default:
			return []
	}
}

function getContextTokenSegments(ctx: ExtensionContext): TokenSegment[] {
	const context = buildSessionContext(
		ctx.sessionManager.getBranch(),
		ctx.sessionManager.getLeafId(),
	)
	const messages = context.messages as TokenMessage[]
	const systemSegment: TokenSegment = {
		category: "system",
		tokens: estimateTokensFromChars(ctx.getSystemPrompt().length),
	}
	const segments: TokenSegment[] = [systemSegment]

	let lastUsageIndex = -1
	let lastUsage: TokenUsage | undefined
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]
		if (
			message.role === "assistant" &&
			message.usage &&
			message.stopReason !== "aborted" &&
			message.stopReason !== "error"
		) {
			lastUsageIndex = i
			lastUsage = message.usage
			break
		}
	}

	if (lastUsageIndex >= 0 && lastUsage) {
		const usageSegments: TokenSegment[] = [systemSegment]
		for (const message of messages.slice(0, lastUsageIndex + 1)) {
			for (const segment of estimateMessageSegments(message)) {
				addTokens(usageSegments, segment.category, segment.tokens)
			}
		}

		segments.splice(
			0,
			segments.length,
			...scaleSegments(usageSegments, calculateContextTokens(lastUsage)),
		)

		for (const message of messages.slice(lastUsageIndex + 1)) {
			for (const segment of estimateMessageSegments(message)) {
				addTokens(segments, segment.category, segment.tokens)
			}
		}

		return segments
	}

	for (const message of messages) {
		for (const segment of estimateMessageSegments(message)) {
			addTokens(segments, segment.category, segment.tokens)
		}
	}

	return segments
}

function ansi(color: string, text: string): string {
	return `${color}${text}${ANSI_RESET}`
}

function contextUsageBarStyle(
	percent: number | null,
): "success" | "warning" | "error" {
	if (percent === null || percent <= 30) return "success"
	return percent > 50 ? "error" : "warning"
}

function renderTokenProgressBar(
	segments: TokenSegment[],
	totalTokens: number,
	usedTokens: number | null,
	fill: (text: string) => string,
): string {
	const emptyBar = ansi(ANSI_LIGHT_YELLOW, "░".repeat(PROGRESS_BAR_WIDTH))
	if (totalTokens <= 0) return emptyBar

	const estimatedUsedTokens = segments.reduce((sum, s) => sum + s.tokens, 0)
	const filledWidth = Math.min(
		PROGRESS_BAR_WIDTH,
		Math.max(
			0,
			Math.round(
				((usedTokens ?? estimatedUsedTokens) / totalTokens) *
					PROGRESS_BAR_WIDTH,
			),
		),
	)
	if (filledWidth <= 0) return emptyBar

	return (
		fill("█".repeat(filledWidth)) +
		ansi(ANSI_LIGHT_YELLOW, "░".repeat(PROGRESS_BAR_WIDTH - filledWidth))
	)
}

function applyCustomFooter(
	ctx: ExtensionContext,
	getLastRunDurationMs: () => number | undefined,
): void {
	ctx.ui.setFooter((tui, theme, footerData) => {
		const unsubscribe = footerData.onBranchChange(() => tui.requestRender())
		const timer = setInterval(() => tui.requestRender(), 1000)
		timer.unref()

		return {
			dispose() {
				unsubscribe()
				clearInterval(timer)
			},
			invalidate() {},
			render(width: number): string[] {
				const sections: string[] = []
				const agentStatus = footerData
					.getExtensionStatuses()
					.get("agent-profile")
				const agentName =
					typeof agentStatus === "string" && agentStatus.trim().length > 0
						? agentStatus.replace(/^🤖\s*/, "")
						: "-"
				sections.push(`\x1b[34m${agentName}${ANSI_RESET}`)

				if (ctx.model) {
					const providerDisplay = ctx.modelRegistry.getProviderDisplayName(
						ctx.model.provider,
					)
					sections.push(theme.fg("dim", `${providerDisplay}/${ctx.model.name}`))
				}

				const contextUsage = ctx.getContextUsage()
				if (contextUsage && contextUsage.contextWindow > 0) {
					const { tokens, contextWindow, percent } = contextUsage
					const usage = tokens !== null ? formatCount(tokens) : "?"
					const progressBar = renderTokenProgressBar(
						getContextTokenSegments(ctx),
						contextWindow,
						tokens,
						(text) => theme.fg(contextUsageBarStyle(percent), text),
					)

					let pct = percent !== null ? `${percent.toFixed(1)}%` : "?%"
					if (percent !== null && percent > 30) {
						pct = theme.fg(percent > 50 ? "error" : "warning", pct)
					}

					sections.push(
						`${progressBar} ${theme.fg("dim", `${usage}/${formatCount(contextWindow)} ${pct}`)}`,
					)
				}

				const lastRunDurationMs = getLastRunDurationMs()
				if (lastRunDurationMs !== undefined) {
					sections.push(theme.fg("dim", formatDuration(lastRunDurationMs)))
				}

				const folder = basename(ctx.cwd)
				const branch = footerData.getGitBranch() ?? "-"
				const title = ctx.sessionManager.getSessionName()
				const rightParts: string[] = []
				if (title) {
					rightParts.push(theme.fg("accent", title))
				}
				rightParts.push(theme.fg("dim", `${folder} @ ${branch}`))
				const right = rightParts.join(theme.fg("dim", " · "))

				const left = ` ${sections.join(" | ")}`
				const pad = Math.max(
					1,
					width - visibleWidth(left) - visibleWidth(right),
				)
				return [truncateToWidth(left + " ".repeat(pad) + right, width)]
			},
		}
	})
}

export default function customFooterExtension(pi: ExtensionAPI): void {
	let enabled = true
	let currentRunStartedAtMs: number | undefined
	let lastRunDurationMs: number | undefined

	pi.on("agent_start", async () => {
		currentRunStartedAtMs = Date.now()
	})

	pi.on("agent_end", async () => {
		if (currentRunStartedAtMs !== undefined) {
			lastRunDurationMs = Date.now() - currentRunStartedAtMs
			currentRunStartedAtMs = undefined
		}
	})

	pi.on("session_start", async (_event, ctx) => {
		if (enabled) applyCustomFooter(ctx, () => lastRunDurationMs)
	})

	pi.registerCommand("custom-footer", {
		description:
			"Enable/disable custom footer (always-on bottom status workaround)",
		handler: async (args, ctx) => {
			const action = (args ?? "").trim().toLowerCase()

			if (action === "off" || action === "disable") {
				enabled = false
				ctx.ui.setFooter(undefined)
				ctx.ui.notify(
					"Custom footer disabled (default footer restored)",
					"info",
				)
				return
			}

			if (action === "on" || action === "enable" || action === "") {
				enabled = true
				applyCustomFooter(ctx, () => lastRunDurationMs)
				ctx.ui.notify("Custom footer enabled", "info")
				return
			}

			ctx.ui.notify("Usage: /custom-footer [on|off]", "warning")
		},
	})
}
