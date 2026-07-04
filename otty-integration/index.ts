/**
 * Otty Integration — report pi agent state to the Otty terminal app.
 *
 * Mirrors Otty's bundled opencode/claude/codex integrations: it spawns
 *   otty-cli state:<kind> session-id=... state=processing|idle agent-pid=... cwd=...
 * so an Otty terminal pane can show the processing / idle badge and fire the
 * "Task complete" notification.
 *
 * State mapping (pi -> Otty):
 *   session_start  -> idle     (seed the session, like opencode's session.created)
 *   agent_start    -> processing (one user prompt's agent loop begins)
 *   agent_end      -> idle       (agent loop finished = task complete)
 *
 * Otty matches each pane to its process tree via `agent-pid`, so even though pi
 * reuses the `opencode` kind (otty-cli rejects unknown kinds), there is no
 * functional conflict with a real opencode pane running alongside.
 *
 * Configuration (env):
 *   OTTY_KIND    Agent kind reported to otty-cli. Default "opencode".
 *                otty-cli only accepts claude / codex / opencode. Switch this to
 *                "pi" once Otty ships a `pi` kind.
 *   OTTY_CLI     Absolute path to the bundled otty-cli binary. Defaults to the
 *                standard macOS install location.
 *   OTTY_SOCKET  Otty IPC socket path. Forwarded to otty-cli; otherwise otty-cli
 *                uses its own default.
 *
 * The extension is a no-op when Otty's CLI is absent or its socket is missing
 * (Otty not running), so it is safe to install unconditionally.
 */

import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir, platform } from "node:os"
import { basename, join } from "node:path"
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent"

const DEFAULT_CLI = "/Applications/Otty.app/Contents/MacOS/otty-cli"
const DEFAULT_KIND = "opencode"

type OttyState = "processing" | "idle"

/** Resolve the otty-cli binary path, or null if it is not installed. */
function resolveCli(): string | null {
	const fromEnv = process.env.OTTY_CLI
	if (fromEnv && existsSync(fromEnv)) return fromEnv
	if (existsSync(DEFAULT_CLI)) return DEFAULT_CLI
	return null
}

/** Resolve the Otty IPC socket path, or null if unknown. */
function resolveSocket(): string | null {
	if (process.env.OTTY_SOCKET && existsSync(process.env.OTTY_SOCKET)) {
		return process.env.OTTY_SOCKET
	}
	if (platform() === "darwin") {
		const defaultSocket = join(
			homedir(),
			"Library/Application Support/io.appmakes.otty/otty.sock",
		)
		if (existsSync(defaultSocket)) return defaultSocket
	}
	return null
}

/** Stable per-session identifier for Otty's session tracking. */
function sessionIdFrom(ctx: ExtensionContext): string {
	const file = ctx.sessionManager.getSessionFile()
	if (file) return basename(file)
	return `pi-${process.pid}`
}

export default function ottyIntegration(pi: ExtensionAPI): void {
	const cliCandidate = resolveCli()
	if (!cliCandidate) return // Otty not installed; nothing to do.
	// Explicit `string` annotation so the closure below keeps the narrowed type.
	const CLI: string = cliCandidate

	const KIND = process.env.OTTY_KIND?.trim() || DEFAULT_KIND

	let lastState: OttyState | null = null
	let lastSocketCheck = 0
	let socketCached: string | null = resolveSocket()

	// Recheck socket existence at most once per second so we notice when Otty
	// quits (the unix socket file is removed) without stat-ing on every event.
	function currentSocket(): string | null {
		const now = Date.now()
		if (now - lastSocketCheck > 1000) {
			lastSocketCheck = now
			socketCached = resolveSocket()
		}
		return socketCached
	}

	function notify(state: OttyState, ctx: ExtensionContext): void {
		if (lastState === state) return // avoid redundant edges
		lastState = state

		// Skip when Otty isn't running (no reachable socket). If the socket path
		// is unknown (e.g. unsupported platform), fall through and let otty-cli
		// decide.
		const socket = currentSocket()
		if (socket === null && platform() === "darwin") return

		const args = [
			`state:${KIND}`,
			`session-id=${sessionIdFrom(ctx)}`,
			`state=${state}`,
			`agent-pid=${process.pid}`,
		]
		if (ctx.cwd) args.push(`cwd=${ctx.cwd}`)

		const env = { ...process.env }
		if (socket) env.OTTY_SOCKET = socket

		// Detached + unref + swallowed errors: a missing/quit Otty must never
		// break the user's pi session.
		try {
			const proc = spawn(CLI, args, {
				stdio: "ignore",
				detached: true,
				env,
			})
			proc.on("error", () => {})
			proc.unref()
		} catch {
			// ignore
		}
	}

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return
		lastState = null // a (possibly different) session: allow re-seeding idle
		notify("idle", ctx)
	})

	pi.on("agent_start", (_event, ctx) => {
		if (!ctx.hasUI) return
		notify("processing", ctx)
	})

	pi.on("agent_end", (_event, ctx) => {
		if (!ctx.hasUI) return
		notify("idle", ctx)
	})

	pi.registerCommand("otty", {
		description: "Show Otty integration status",
		handler: async (_args, ctx) => {
			if (!CLI) {
				ctx.ui.notify("Otty CLI not found — extension inactive", "warning")
				return
			}
			const socket = currentSocket()
			ctx.ui.notify(
				`Otty: kind=${KIND} state=${lastState ?? "-"} socket=${
					socket ? "connected" : "not running"
				}`,
				"info",
			)
		},
	})
}
