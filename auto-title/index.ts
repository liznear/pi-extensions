/**
 * Auto-Title Extension
 *
 * Automatically generates a short, descriptive title for the session based on
 * the user's first prompt and sets it via `pi.setSessionName()` so the session
 * selector shows a meaningful name instead of the raw first message.
 *
 * Title generation runs entirely in the background: the `before_agent_start`
 * handler kicks off the work and returns immediately, so the normal agent
 * workflow is never blocked.
 *
 * Model configuration (first match wins):
 *   1. `PI_AUTO_TITLE_MODEL` env var, format `provider/modelId`
 *   2. Project-local config  `<cwd>/.pi/auto-title.json`   -> { "model": "provider/modelId", "maxLength": 50, "enabled": true }
 *   3. Global config         `~/.pi/agent/auto-title.json`  (same shape)
 *   4. Fallback: the session's active model
 *
 * Commands:
 *   /title        Regenerate the title now from the first user message.
 *   /title-model  Pick the model used for title generation (persisted to the
 *                 global config). Lists only models with auth configured.
 *   /title-config Show the current configuration.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import { complete } from "@earendil-works/pi-ai"
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent"

const EXT_NAME = "auto-title"
const ENV_VAR = "PI_AUTO_TITLE_MODEL"
// Default pi config dir. Newer pi versions export CONFIG_DIR_NAME; hardcode
// here for cross-version compatibility.
const PROJECT_CONFIG_DIR = ".pi"
const GLOBAL_CONFIG_PATH = join(homedir(), ".pi", "agent", "auto-title.json")
const CONFIG_FILE_NAME = "auto-title.json"
const DEFAULT_MAX_LENGTH = 50
const GENERATION_TIMEOUT_MS = 30_000
// Generation budget for the title completion. Must be large enough for reasoning
// models to finish thinking AND emit the short title — a tiny budget (e.g. 24)
// gets entirely consumed by reasoning tokens, yielding an empty response.
const TITLE_MAX_TOKENS = 512

type Config = {
	enabled?: boolean
	model?: string
	maxLength?: number
}

type ModelSpec = { provider: string; modelId: string }

type TextBlock = { type: "text"; text: string }
type UserMessageContent = string | Array<{ type?: string; text?: string }>

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function readJsonIfExists(path: string): Config {
	try {
		if (!existsSync(path)) return {}
		return JSON.parse(readFileSync(path, "utf-8")) as Config
	} catch {
		return {}
	}
}

function loadConfig(ctx: ExtensionContext): Config {
	const globalCfg = readJsonIfExists(GLOBAL_CONFIG_PATH)
	const projectCfg = readJsonIfExists(
		join(ctx.cwd, PROJECT_CONFIG_DIR, CONFIG_FILE_NAME),
	)
	// Project-local overrides global.
	return { ...globalCfg, ...projectCfg }
}

function writeGlobalConfig(cfg: Config): void {
	try {
		mkdirSync(join(homedir(), ".pi", "agent"), { recursive: true })
		writeFileSync(
			GLOBAL_CONFIG_PATH,
			`${JSON.stringify(cfg, null, 2)}\n`,
			"utf-8",
		)
	} catch (err) {
		throw new Error(
			`Failed to write ${GLOBAL_CONFIG_PATH}: ${(err as Error).message}`,
		)
	}
}

function parseModelSpec(spec: string): ModelSpec | undefined {
	const trimmed = spec.trim()
	const idx = trimmed.indexOf("/")
	if (idx <= 0 || idx >= trimmed.length - 1) return undefined
	return { provider: trimmed.slice(0, idx), modelId: trimmed.slice(idx + 1) }
}

function resolveModelSpec(config: Config): ModelSpec | undefined {
	const fromEnv = process.env[ENV_VAR]?.trim()
	if (fromEnv) {
		const parsed = parseModelSpec(fromEnv)
		if (parsed) return parsed
	}
	if (config.model) {
		const parsed = parseModelSpec(config.model)
		if (parsed) return parsed
	}
	// Fallback: undefined means "use the active session model".
	return undefined
}

// ---------------------------------------------------------------------------
// Prompt extraction
// ---------------------------------------------------------------------------

function extractText(content: UserMessageContent | undefined): string {
	if (!content) return ""
	if (typeof content === "string") return content
	if (!Array.isArray(content)) return ""
	return content
		.filter(
			(part): part is TextBlock =>
				part?.type === "text" && typeof part.text === "string",
		)
		.map((part) => part.text ?? "")
		.join("\n")
		.trim()
}

function firstUserPrompt(ctx: ExtensionContext): string | undefined {
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue
		const message = (
			entry as { message?: { role?: string; content?: UserMessageContent } }
		).message
		if (message?.role !== "user") continue
		const text = extractText(message.content)
		if (text) return text
	}
	return undefined
}

// ---------------------------------------------------------------------------
// Title generation
// ---------------------------------------------------------------------------

function cleanTitle(raw: string, maxLength: number): string {
	let title = raw
		.split("\n")[0] // single line
		.replace(/^["'`]|["'`]$/g, "") // strip wrapping quotes
		.replace(/^\s*(title|session)\s*[:：-]\s*/i, "") // strip "Title:" prefix
		.replace(/[.\s]+$/g, "") // trailing period / whitespace
		.replace(/\s+/g, " ") // collapse whitespace
		.trim()

	if (title.length > maxLength) {
		const cut = title.slice(0, maxLength)
		const lastSpace = cut.lastIndexOf(" ")
		title = (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).replace(
			/[,;:]\s*$/,
			"",
		)
	}
	return title
}

async function generateTitle(
	ctx: ExtensionContext,
	prompt: string,
	config: Config,
): Promise<string | undefined> {
	const spec = resolveModelSpec(config)
	const configured = spec
		? ctx.modelRegistry.find(spec.provider, spec.modelId)
		: undefined

	// If a model was explicitly configured but could not be resolved, surface it
	// once — then still fall back to the active session model below.
	if (spec && !configured) {
		ctx.ui.notify(
			`[${EXT_NAME}] model not found: ${spec.provider}/${spec.modelId}`,
			"warning",
		)
	}

	const maxLength = config.maxLength ?? DEFAULT_MAX_LENGTH
	const systemPrompt = [
		"You write a concise, descriptive title for a coding chat session based on the user's first message.",
		"Rules:",
		"- 3 to 8 words.",
		"- Plain text. No quotes. No trailing punctuation.",
		"- No prefix such as 'Title:' or 'Session:'.",
		"- Capture the task or topic, not a greeting.",
		`- Keep it under ${maxLength} characters.`,
	].join("\n")

	// Resolve auth + run one completion against a model. Throws on hard errors
	// (auth failure, network, region-lock, abort) so the caller can fall back.
	const completeOnce = async (
		model: NonNullable<typeof ctx.model>,
	): Promise<string | undefined> => {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model)
		if (!auth.ok) {
			throw new Error(`auth error: ${auth.error}`)
		}

		const controller = new AbortController()
		const timer = setTimeout(() => controller.abort(), GENERATION_TIMEOUT_MS)
		try {
			const response = await complete(
				model,
				{
					systemPrompt,
					messages: [
						{
							role: "user",
							content: [{ type: "text", text: prompt }],
							timestamp: Date.now(),
						},
					],
				},
				{
					apiKey: auth.apiKey,
					headers: auth.headers,
					signal: controller.signal,
					cacheRetention: "none",
					temperature: 0.3,
					maxTokens: TITLE_MAX_TOKENS,
					// Titles never need reasoning; ask supporting providers to skip it.
					reasoning: "off",
				},
			)

			const text = response.content
				.filter(
					(c): c is TextBlock =>
						c.type === "text" && typeof c.text === "string",
				)
				.map((c) => c.text)
				.join(" ")
				.trim()

			return cleanTitle(text, maxLength) || undefined
		} finally {
			clearTimeout(timer)
		}
	}

	// Candidate models, deduped: configured (env/config) first, then the active
	// session model as a resilient fallback when the configured model is
	// unavailable (e.g. region-locked, auth error, network failure).
	const seen = new Set<string>()
	const candidates = [configured, ctx.model].filter(
		(m): m is NonNullable<typeof ctx.model> => {
			if (!m) return false
			const key = `${m.provider}/${m.id}`
			if (seen.has(key)) return false
			seen.add(key)
			return true
		},
	)

	let lastError: unknown
	for (const model of candidates) {
		try {
			const title = await completeOnce(model)
			if (title) return title
		} catch (err) {
			lastError = err
		}
	}

	if (lastError !== undefined && ctx.hasUI) {
		const message =
			lastError instanceof Error ? lastError.message : String(lastError)
		ctx.ui.notify(
			`[${EXT_NAME}] title generation failed: ${message}`,
			"warning",
		)
	}
	return undefined
}

// Run title generation in the background without blocking the caller.
function runTitleGeneration(
	ctx: ExtensionContext,
	prompt: string,
	config: Config,
	onDone: (title: string | undefined) => void,
): void {
	generateTitle(ctx, prompt, config)
		.then(onDone)
		.catch((err: unknown) => {
			const message = err instanceof Error ? err.message : String(err)
			if (ctx.hasUI) {
				ctx.ui.notify(
					`[${EXT_NAME}] title generation failed: ${message}`,
					"error",
				)
			}
		})
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

// Terminal tab/window title shown by the host terminal emulator (Orca's
// embedded terminal, iTerm2, Ghostty, WezTerm, ...). Mirrors the pi session
// name so the tab bar reflects the current session at a glance.
function formatTerminalTitle(name: string | undefined, cwd: string): string {
	const folder = basename(cwd)
	return name ? `π - ${name} - ${folder}` : `π - ${folder}`
}

/**
 * `session_info_changed` is emitted by the runtime whenever the session display
 * name changes (/name, /title, auto-title, RPC, ...). It exists in the running
 * 0.83.0 runtime but is missing from the installed 0.74.0 dev type union (it
 * was added to the public union in 0.83.0), so it is typed locally and `pi.on`
 * is cast narrowly at the call site to bridge the version skew.
 */
type SessionInfoChangedEvent = {
	type: "session_info_changed"
	name: string | undefined
}

export default function (pi: ExtensionAPI) {
	// In-memory guard so we only auto-title once per session instance. Reset on
	// any (re)start of the session runtime.
	let hasTitledThisSession = false

	pi.on("session_start", (_event, ctx) => {
		hasTitledThisSession = false
		// Restore the terminal tab title immediately for resumed/named sessions.
		if (ctx.hasUI) {
			ctx.ui.setTitle(formatTerminalTitle(pi.getSessionName(), ctx.cwd))
		}
	})

	// Mirror the session name to the terminal tab title. This is the single
	// source of truth: /name, /title, auto-title, and RPC all funnel through
	// session_info_changed, so the host terminal (incl. Orca) stays in sync
	// without coupling to each call site. Typed via a narrow cast (see
	// SessionInfoChangedEvent above) due to dev-type version skew.
	const onSessionInfoChanged = pi.on as unknown as (
		event: "session_info_changed",
		handler: (e: SessionInfoChangedEvent, ctx: ExtensionContext) => void,
	) => void
	onSessionInfoChanged("session_info_changed", (event, ctx) => {
		if (ctx.hasUI) {
			ctx.ui.setTitle(formatTerminalTitle(event.name, ctx.cwd))
		}
	})

	// Auto-title after the first prompt. Runs entirely in the background: the
	// handler returns immediately so the agent loop is never delayed.
	pi.on("before_agent_start", (event, ctx) => {
		if (hasTitledThisSession) return

		const config = loadConfig(ctx)
		if (config.enabled === false) return

		// Already named (e.g. resumed session) — nothing to do.
		if (pi.getSessionName()) {
			hasTitledThisSession = true
			return
		}

		const prompt = event.prompt?.trim()
		if (!prompt) return

		// Claim the slot before launching async work to avoid duplicate runs.
		hasTitledThisSession = true

		runTitleGeneration(ctx, prompt, config, (title) => {
			if (title) {
				pi.setSessionName(title)
			}
		})
	})

	// /title [custom title] — set a title manually, or regenerate from the
	// first user message when no argument is given.
	pi.registerCommand("title", {
		description:
			"Set a custom title, or regenerate it from the first user message",
		handler: async (args, ctx) => {
			const custom = args?.trim()
			if (custom) {
				hasTitledThisSession = true
				pi.setSessionName(custom)
				ctx.ui.notify(`Title set: ${custom}`, "info")
				return
			}

			const prompt = firstUserPrompt(ctx)
			if (!prompt) {
				ctx.ui.notify("No user message found to title from", "warning")
				return
			}

			const config = loadConfig(ctx)
			ctx.ui.setStatus(EXT_NAME, "Generating title…")

			const title = await generateTitle(ctx, prompt, config)
			ctx.ui.setStatus(EXT_NAME, undefined)

			if (title) {
				hasTitledThisSession = true
				pi.setSessionName(title)
				ctx.ui.notify(`Title set: ${title}`, "info")
			}
		},
	})

	// /title-model — pick the model used to generate titles (persisted globally).
	pi.registerCommand("title-model", {
		description: "Choose the model used to generate session titles",
		handler: async (_args, ctx) => {
			const models = ctx.modelRegistry.getAvailable()
			if (models.length === 0) {
				ctx.ui.notify("No models with configured auth found", "warning")
				return
			}

			const currentConfig = loadConfig(ctx)
			const activeSpec = ctx.model
				? `${ctx.model.provider}/${ctx.model.id}`
				: "(none)"
			const current =
				process.env[ENV_VAR] ?? currentConfig.model ?? `(active: ${activeSpec})`

			const clearOption = "(use active session model)"
			const options = models
				.map((m) => `${m.provider}/${m.id} — ${m.name}`)
				.sort((a, b) => a.localeCompare(b))

			const choice = await ctx.ui.select(`Title model [current: ${current}]:`, [
				clearOption,
				...options,
			])
			if (choice === undefined) return

			const globalCfg = readJsonIfExists(GLOBAL_CONFIG_PATH)
			if (choice === clearOption) {
				delete globalCfg.model
			} else {
				const spec = choice.split(" — ")[0]
				if (!parseModelSpec(spec)) {
					ctx.ui.notify(`Invalid model: ${spec}`, "error")
					return
				}
				globalCfg.model = spec
			}

			try {
				writeGlobalConfig(globalCfg)
				ctx.ui.notify(
					globalCfg.model
						? `Title model set to ${globalCfg.model}`
						: "Title model cleared (will use active session model)",
					"info",
				)
			} catch (err) {
				ctx.ui.notify((err as Error).message, "error")
			}
		},
	})

	// /title-config — show the resolved configuration.
	pi.registerCommand("title-config", {
		description: "Show the auto-title configuration",
		handler: async (_args, ctx) => {
			const config = loadConfig(ctx)
			const spec = resolveModelSpec(config)
			const model =
				(spec && `${spec.provider}/${spec.modelId}`) ??
				(ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "(none)")
			const lines = [
				`model:        ${model}`,
				`maxLength:    ${config.maxLength ?? DEFAULT_MAX_LENGTH}`,
				`enabled:      ${config.enabled === false ? "false" : "true"}`,
				`env override: ${process.env[ENV_VAR] ?? "(unset)"}`,
				`global cfg:   ${GLOBAL_CONFIG_PATH}`,
			]
			ctx.ui.notify(lines.join("\n"), "info")
		},
	})
}
