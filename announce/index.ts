/**
 * Announce Extension
 *
 * Gives the LLM an `announce` tool to broadcast what it is currently doing.
 * The latest intention replaces the built-in "Working..." streaming message
 * (the spinner is kept), so the user can follow along while the agent works. The intention is also mirrored
 * to the terminal tab title (OSC 0 for Orca's embedded terminal, iTerm2,
 * Ghostty, WezTerm, ...; `tmux rename-window` under tmux; `screen -X title`
 * under GNU screen) and restored once the agent settles.
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
 *   { "mode": "enforce", "maxToolCalls": 3, "tabTitle": true }
 *
 * Commands:
 *   /announce [enforce|encourage|off]  Show current config or persist a mode.
 *   /announce clear                    Restore the default working message.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import { Text } from "@earendil-works/pi-tui"
import { Type } from "typebox"

const TOOL_NAME = "announce"
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
const MAX_TAB_TITLE_CHARS = 60

type Mode = "off" | "encourage" | "enforce"

type Config = {
	mode?: Mode
	maxToolCalls?: number
	tabTitle?: boolean
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

function resolveTabTitle(config: Config): boolean {
	return config.tabTitle !== false
}

// ---------------------------------------------------------------------------
// Working message
// ---------------------------------------------------------------------------

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function showIntention(
	ctx: ExtensionContext,
	intention: string | undefined,
): void {
	if (!ctx.hasUI) return
	// An empty intention restores the default "Working..." message.
	if (!intention?.trim()) {
		ctx.ui.setWorkingMessage()
		return
	}
	ctx.ui.setWorkingMessage(clip(intention.trim(), MAX_INTENTION_CHARS))
}

// ---------------------------------------------------------------------------
// Tab title (multi-environment)
// ---------------------------------------------------------------------------

/** Terminal hosting this pi process, resolved once at load time. */
type TerminalEnv = {
	/** Inside tmux ($TMUX set): OSC titles are usually swallowed by tmux. */
	tmux: boolean
	/** Inside GNU screen ($STY set, or TERM=screen* outside tmux). */
	screen: boolean
}

function detectTerminalEnv(): TerminalEnv {
	const tmux = Boolean(process.env.TMUX)
	return {
		tmux,
		screen:
			!tmux &&
			(Boolean(process.env.STY) ||
				(process.env.TERM ?? "").startsWith("screen")),
	}
}

/**
 * Strip characters that would break OSC sequences or tmux/screen arguments,
 * collapse whitespace, and clip to a tab-friendly length.
 */
function sanitizeTitle(text: string): string {
	// Strip control characters without spelling them out in a regex pattern
	// (biome flags control-char escapes inside regex character classes).
	const printable = [...text]
		.filter((ch) => {
			const code = ch.codePointAt(0) ?? 0
			return code >= 0x20 && code !== 0x7f
		})
		.join("")
	return clip(printable.replace(/\s+/g, " ").trim(), MAX_TAB_TITLE_CHARS)
}

/** Fire-and-forget external command; tab titles are best-effort. */
function runBestEffort(
	pi: ExtensionAPI,
	command: string,
	args: string[],
): void {
	pi.exec(command, args, { timeout: 2000 }).catch(() => {})
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// Number of non-announce tool calls executed since the last announce.
	// +Infinity means "announce required before the next tool call" (start of
	// a user turn).
	let toolCallsSinceAnnounce = Number.POSITIVE_INFINITY

	// --- Tab title ----------------------------------------------------------
	const termEnv = detectTerminalEnv()
	// Captured `automatic-rename` value so tmux windows return to their
	// previous naming behavior when we restore.
	let tmuxAutomaticRename: string | undefined

	function captureTmuxAutomaticRename(): void {
		if (!termEnv.tmux) return
		pi.exec("tmux", ["show-option", "-wv", "automatic-rename"], {
			timeout: 2000,
		})
			.then((result) => {
				const value = result.stdout.trim()
				if (result.code === 0 && value) tmuxAutomaticRename = value
			})
			.catch(() => {})
	}

	function setTabTitle(ctx: ExtensionContext, title: string): void {
		if (!ctx.hasUI || !title) return
		ctx.ui.setTitle(title)
		if (termEnv.tmux) {
			runBestEffort(pi, "tmux", ["rename-window", title])
		} else if (termEnv.screen) {
			runBestEffort(pi, "screen", ["-X", "title", title])
		}
	}

	/** Restore uses the same format as auto-title, so both compose. */
	function restoreTabTitle(ctx: ExtensionContext): void {
		if (!ctx.hasUI || !resolveTabTitle(loadConfig(ctx))) return
		const name = pi.getSessionName()
		const folder = basename(ctx.cwd)
		const base = name ? `π - ${name} - ${folder}` : `π - ${folder}`
		ctx.ui.setTitle(base)
		if (termEnv.tmux) {
			runBestEffort(pi, "tmux", ["rename-window", base])
			if (tmuxAutomaticRename !== undefined) {
				runBestEffort(pi, "tmux", [
					"set-option",
					"-w",
					`automatic-rename=${tmuxAutomaticRename}`,
				])
			}
		} else if (termEnv.screen) {
			runBestEffort(pi, "screen", ["-X", "title", base])
		}
	}

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
		captureTmuxAutomaticRename()
		restoreTabTitle(ctx)
	})

	// New user prompt: drop the stale intention and require a fresh announce
	// before the first tool call of the turn (enforce mode).
	pi.on("before_agent_start", (_event, ctx) => {
		toolCallsSinceAnnounce = Number.POSITIVE_INFINITY
		showIntention(ctx, undefined)
		restoreTabTitle(ctx)
	})

	// Work fully settled: the intention is stale, restore the default
	// working message and put the tab title back to its resting form.
	pi.on("agent_settled", (_event, ctx) => {
		showIntention(ctx, undefined)
		restoreTabTitle(ctx)
	})

	pi.on("session_shutdown", (_event, ctx) => {
		restoreTabTitle(ctx)
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
			"The message replaces the 'Working...' status line while you work. " +
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
			if (resolveTabTitle(loadConfig(ctx))) {
				setTabTitle(ctx, `π ◈ ${sanitizeTitle(params.intention)}`)
			}
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
			// The streaming working message is the real output; keep the
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
				ctx.ui.notify("Working message restored to default", "info")
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
					`tabTitle:    ${resolveTabTitle(config) ? "on" : "off"}`,
					`global cfg:  ${GLOBAL_CONFIG_PATH}`,
					"usage:       /announce [enforce|encourage|off|clear]",
				].join("\n"),
				"info",
			)
		},
	})
}
