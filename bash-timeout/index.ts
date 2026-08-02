/**
 * bash-timeout Extension
 *
 * Enforces a default timeout on every `bash` invocation that doesn't already
 * specify one, preventing runaway commands from hanging the agent loop.
 *
 * The default timeout is 60 seconds. Override it with the
 * `PI_BASH_TIMEOUT_SECONDS` environment variable (must be a positive number).
 *
 * How it works:
 *   - Intercepts `tool_call` events for the built-in `bash` tool.
 *   - If the call omits a `timeout`, injects the configured default (in
 *     seconds) before execution. Calls that already specify a timeout are
 *     left untouched.
 *   - ALSO intercepts the `command_run` tool (from the command-run
 *     extension). command_run dispatches its sub-commands directly to fresh
 *     built-in tool instances, so the per-sub-command `bash` tool_call event
 *     never fires for them. We walk the batch here and inject the default
 *     timeout into any `bash` sub-command that omits one, before the batch
 *     executes. If command-run isn't loaded, this handler is simply a no-op.
 *
 * No new tools, commands, or UI are added — the behavior is transparent to
 * both the user and the LLM.
 */

import {
	type ExtensionAPI,
	isToolCallEventType,
} from "@earendil-works/pi-coding-agent"

const ENV_VAR = "PI_BASH_TIMEOUT_SECONDS"
const DEFAULT_TIMEOUT_SECONDS = 60

/** Tool name registered by the command-run extension. */
const COMMAND_RUN_TOOL = "command_run"

/**
 * Expected shape of a `command_run` tool_call input (a custom tool, so the
 * event only types this as `Record<string, unknown>` — we validate at runtime).
 */
type CommandRunInput = {
	commands: Array<{
		command_type: string
		parameters: Record<string, unknown>
		step?: number
	}>
}

/** Resolve the configured default timeout, falling back to 60s on bad input. */
function resolveDefaultTimeout(): number {
	const raw = process.env[ENV_VAR]
	if (raw === undefined || raw === "") return DEFAULT_TIMEOUT_SECONDS
	const n = Number(raw)
	return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_SECONDS
}

/** True when `value` is a plain record (not null and not an array). */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Inject the default timeout into `params.timeout` if one wasn't specified. */
function ensureTimeout(
	params: Record<string, unknown>,
	defaultTimeout: number,
): void {
	if (params.timeout === undefined || params.timeout === null) {
		params.timeout = defaultTimeout
	}
}

export default function bashTimeoutExtension(pi: ExtensionAPI): void {
	const defaultTimeout = resolveDefaultTimeout()

	pi.on("tool_call", (event) => {
		// Built-in `bash` tool: inject the default only when omitted.
		if (isToolCallEventType("bash", event)) {
			ensureTimeout(event.input, defaultTimeout)
			return
		}

		// `command_run` tool: its sub-commands bypass the normal tool_call
		// pipeline (fresh built-in instances), so patch bash entries in the
		// batch here, before command_run executes them.
		if (
			isToolCallEventType<"command_run", CommandRunInput>(
				COMMAND_RUN_TOOL,
				event,
			)
		) {
			const commands = event.input.commands
			if (!Array.isArray(commands)) return
			for (const command of commands) {
				if (!isRecord(command)) continue
				if (command.command_type !== "bash") continue
				if (!isRecord(command.parameters)) continue
				ensureTimeout(command.parameters, defaultTimeout)
			}
		}
	})

	pi.on("session_start", (event, ctx) => {
		// Announce once on a fresh process startup; skip reload/resume/fork noise.
		if (event.reason !== "startup") return
		ctx.ui.notify(
			`bash-timeout: default ${defaultTimeout}s timeout active`,
			"info",
		)
	})
}
