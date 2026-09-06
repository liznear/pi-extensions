/**
 * Orca tab-title mirroring.
 *
 * Orca's embedded terminal does not follow OSC 0 window-title sequences for
 * the visible tab title: titles written to stdout by pi (core's
 * `updateTerminalTitle` and the extensions in this bundle) only update
 * Orca's internal record (visible in `orca terminal show --json` ->
 * `result.terminal.title`). The displayed tab title follows
 * `orca terminal rename` instead, which persists and takes precedence over
 * later OSC output. So every terminal-title write in this bundle mirrors
 * into a best-effort rename when running inside an Orca-managed terminal
 * (detected via `$ORCA_TERMINAL_HANDLE`).
 *
 * Deliberately free of `@earendil-works/pi-coding-agent` imports: this file
 * is shared across extensions that resolve different copies of that package
 * (command-center vendors its own), so a type dependency here would create a
 * cross-copy type mismatch.
 */
import { execFile } from "node:child_process"

const RENAME_TIMEOUT_MS = 2000

/** Handle of the Orca terminal hosting this process, when inside one. */
export function orcaTerminalHandle(): string | undefined {
	const handle = process.env.ORCA_TERMINAL_HANDLE
	return handle ? handle : undefined
}

/**
 * Resolve the `orca` CLI binary. Only reached with an Orca terminal handle
 * set, and inside Orca-managed terminals `orca` always resolves to the Orca
 * CLI on every platform; dev checkouts prefer `orca-dev` and managed WSL
 * sessions honor `$ORCA_CLI_COMMAND`.
 */
export function resolveOrcaCliCommand(): string {
	if (process.env.ORCA_CLI_COMMAND) return process.env.ORCA_CLI_COMMAND
	if (process.env.ORCA_DEV_REPO_ROOT) return "orca-dev"
	return "orca"
}

/** CLI argv for `orca terminal rename`. */
export function orcaRenameArgs(handle: string, title: string): string[] {
	return [
		"terminal",
		"rename",
		"--terminal",
		handle,
		"--title",
		title,
		"--json",
	]
}

/**
 * Mirror a terminal-title write to the visible Orca tab title. No-op outside
 * Orca-managed terminals; fire-and-forget and best-effort (errors are
 * swallowed — tab titles are cosmetic).
 */
export function renameOrcaTabTitle(title: string): void {
	const handle = orcaTerminalHandle()
	if (!handle || !title) return
	execFile(
		resolveOrcaCliCommand(),
		orcaRenameArgs(handle, title),
		{ timeout: RENAME_TIMEOUT_MS },
		() => {},
	)
}
