/**
 * Announce Extension
 *
 * Gives the LLM an `announce` tool to broadcast what it is currently doing.
 * The latest intention is rendered as a widget above the input editor, so the
 * user can follow along while the agent works.
 *
 * Two levels of persuasion (plus off):
 *   - "encourage": `promptSnippet`/`promptGuidelines` instruct the model to
 *     call announce before each batch of work. Zero overhead, no blocking.
 *   - "enforce": additionally gates every other tool call. If the model has
 *     not called announce since the user's last prompt, or has run more than
 *     `maxToolCalls` tool calls since its last announce, the next tool call is
 *     blocked with a reason telling the model to announce first.
 *   - "off": the tool is deactivated entirely.
 *
 * Configuration (project-local `<cwd>/.pi/announce.json` overrides global
 * `~/.pi/agent/announce.json`; the `PI_ANNOUNCE_MODE` env var overrides both):
 *
 *   { "mode": "enforce", "maxToolCalls": 3 }
 *
 * Commands:
 *   /announce [enforce|encourage|off]  Show current config or persist a mode.
 *   /announce clear                    Clear the widget.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import { Text } from "@earendil-works/pi-tui"
import { Type } from "typebox"

const TOOL_NAME = "announce"
const WIDGET_NAME = "announce-intention"
const ENV_VAR = "PI_ANNOUNCE_MODE"
// Default pi config dir. Newer pi versions export CONFIG_DIR_NAME; hardcode
// here for cross-version compatibility (same as auto-title).
const PROJECT_CONFIG_DIR = ".pi"
const CONFIG_FILE_NAME = "announce.json"
const GLOBAL_CONFIG_PATH = join(homedir(), ".pi", "agent", "announce.json")

const DEFAULT_MODE: Mode = "enforce"
const DEFAULT_MAX_TOOL_CALLS = 3
const MIN_MAX_TOOL_CALLS = 1
const MAX_MAX_TOOL_CALLS = 50
const MAX_INTENTION_CHARS = 110
const MAX_TRANSCRIPT_CHARS = 80

type Mode = "off" | "encourage" | "enforce"

type Config = {
	mode?: Mode
	maxToolCalls?: number
}

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

function resolveMode(config: Config): Mode {
	const fromEnv = process.env[ENV_VAR]?.trim().toLowerCase()
	if (fromEnv === "off" || fromEnv === "encourage" || fromEnv === "enforce") {
		return fromEnv
	}
	return config.mode ?? DEFAULT_MODE
}

function resolveMaxToolCalls(config: Config): number {
	const raw = config.maxToolCalls
	if (typeof raw !== "number" || !Number.isFinite(raw)) {
		return DEFAULT_MAX_TOOL_CALLS
	}
	return Math.min(
		MAX_MAX_TOOL_CALLS,
		Math.max(MIN_MAX_TOOL_CALLS, Math.trunc(raw)),
	)
}

// ---------------------------------------------------------------------------
// Widget
// ---------------------------------------------------------------------------

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function showIntention(
	ctx: ExtensionContext,
	intention: string | undefined,
): void {
	if (!ctx.hasUI) return
	if (!intention?.trim()) {
		ctx.ui.setWidget(WIDGET_NAME, undefined)
		return
	}
	const theme = ctx.ui.theme
	const mark = theme.fg("accent", "◈")
	const text = theme.fg("muted", clip(intention.trim(), MAX_INTENTION_CHARS))
	ctx.ui.setWidget(WIDGET_NAME, [`${mark} ${text}`])
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// Number of non-announce tool calls executed since the last announce.
	// +Infinity means "announce required before the next tool call" (start of
	// a user turn).
	let toolCallsSinceAnnounce = Number.POSITIVE_INFINITY

	function syncToolActive(ctx: ExtensionContext): void {
		const mode = resolveMode(loadConfig(ctx))
		const active = pi.getActiveTools()
		const has = active.includes(TOOL_NAME)
		if (mode === "off" && has) {
			pi.setActiveTools(active.filter((name) => name !== TOOL_NAME))
		} else if (mode !== "off" && !has) {
			pi.setActiveTools([...new Set([...active, TOOL_NAME])])
		}
	}

	pi.on("session_start", (_event, ctx) => {
		toolCallsSinceAnnounce = Number.POSITIVE_INFINITY
		showIntention(ctx, undefined)
		syncToolActive(ctx)
	})

	// New user prompt: drop the stale intention and require a fresh announce
	// before the first tool call of the turn (enforce mode).
	pi.on("before_agent_start", (_event, ctx) => {
		toolCallsSinceAnnounce = Number.POSITIVE_INFINITY
		showIntention(ctx, undefined)
	})

	// Work fully settled: the intention is stale, clear the widget.
	pi.on("agent_settled", (_event, ctx) => {
		showIntention(ctx, undefined)
	})

	// Reset on the tool_call event (preflight runs in assistant source order)
	// so sibling tool calls in the same batch pass the gate when announce
	// precedes them.
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === TOOL_NAME) {
			toolCallsSinceAnnounce = 0
			return
		}

		const config = loadConfig(ctx)
		if (resolveMode(config) !== "enforce") return

		if (toolCallsSinceAnnounce < resolveMaxToolCalls(config)) {
			toolCallsSinceAnnounce++
			return
		}

		return {
			block: true,
			reason: `Gated by ${TOOL_NAME}: call the ${TOOL_NAME} tool first with a one-line summary of what you are about to do, then retry this tool call.`,
		}
	})

	pi.registerTool({
		name: TOOL_NAME,
		label: "Announce",
		description:
			"Tell the user what you are about to do or are currently doing. " +
			"The message is displayed above the input box while you work. " +
			"Use one plain line of at most ~12 words, naming files, commands, or the next step.",
		promptSnippet:
			"Broadcast a one-line status of what you are working on to the user",
		promptGuidelines: [
			`Call ${TOOL_NAME} with a one-line summary of what you are about to do before each batch of tool calls, and again whenever the focus of your work changes.`,
			`Keep ${TOOL_NAME} messages short and specific (file names, commands, next step); do not call ${TOOL_NAME} more than once per batch.`,
		],
		parameters: Type.Object({
			intention: Type.String({
				description:
					"One line (max ~12 words) describing what you are about to do or are currently doing",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			showIntention(ctx, params.intention)
			return {
				content: [{ type: "text", text: "ok" }],
				details: { intention: params.intention },
			}
		},
		renderCall(args, theme, context) {
			const text =
				(context.lastComponent as Text | undefined) ?? new Text("", 0, 0)
			const intention =
				(args as { intention?: string } | undefined)?.intention ?? ""
			text.setText(
				theme.fg("toolTitle", theme.bold("announce ")) +
					theme.fg("muted", clip(intention, MAX_TRANSCRIPT_CHARS)),
			)
			return text
		},
		renderResult() {
			// The widget above the editor is the real output; keep the
			// transcript row minimal.
			return new Text("", 0, 0)
		},
	})

	// /announce [enforce|encourage|off|clear]
	pi.registerCommand("announce", {
		description: "Show or configure the announce extension",
		handler: async (args, ctx) => {
			const action = (args ?? "").trim().toLowerCase()

			if (action === "clear") {
				showIntention(ctx, undefined)
				ctx.ui.notify("Intention widget cleared", "info")
				return
			}

			if (action === "off" || action === "encourage" || action === "enforce") {
				const globalCfg = readJsonIfExists(GLOBAL_CONFIG_PATH)
				globalCfg.mode = action
				try {
					writeGlobalConfig(globalCfg)
				} catch (err) {
					ctx.ui.notify((err as Error).message, "error")
					return
				}
				syncToolActive(ctx)
				if (action === "off") showIntention(ctx, undefined)
				ctx.ui.notify(`announce mode set to: ${action}`, "info")
				return
			}

			const config = loadConfig(ctx)
			const mode = resolveMode(config)
			const envOverride = process.env[ENV_VAR]
			ctx.ui.notify(
				[
					`mode:        ${mode}${envOverride ? ` (env: ${envOverride})` : ""}`,
					`maxToolCalls: ${resolveMaxToolCalls(config)} (enforce mode)`,
					`global cfg:  ${GLOBAL_CONFIG_PATH}`,
					"usage:       /announce [enforce|encourage|off|clear]",
				].join("\n"),
				"info",
			)
		},
	})
}
