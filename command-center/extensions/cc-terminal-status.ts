import path from "node:path"

/** Braille spinner prefix recognized by terminal agent-state integrations. */
export const WORKING_TERMINAL_SPINNER = "⠋"

/** Format the base terminal title used by Pi sessions. */
export function formatTerminalTitle(
	sessionName: string | undefined,
	cwd: string,
): string {
	const folder = path.basename(cwd)
	return sessionName ? `π - ${sessionName} - ${folder}` : `π - ${folder}`
}

/** Add or remove the terminal-level working signal without starting an agent turn. */
export function formatTerminalActivityTitle(
	baseTitle: string,
	working: boolean,
): string {
	return working ? `${WORKING_TERMINAL_SPINNER} ${baseTitle}` : baseTitle
}
