import {
	CustomEditor,
	type ExtensionAPI,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent"

// ---------------------------------------------------------------------------
// /cc syntax highlighting
//
// Subclasses the TUI input editor so `/cc <subcommand> <missionId>` lines
// colorize as you type. The pure line transform (`highlightCcLine`) is
// exported for tests; the editor subclass just feeds it rendered lines.
//
// Theme mapping (see themes.md → Syntax Highlighting):
//   /cc           → syntaxKeyword   (the command prefix)
//   <subcommand>  → syntaxFunction  (attach, list, abort, …)
//   <missionId>   → syntaxString    (mission-id subcommands only)
// Everything else (free-form args, non-/cc lines) passes through unchanged.
//
// NOTE: `setEditorComponent` replaces the input editor wholesale. If multiple
// extensions customize the editor, the last one to run wins — this extension
// deliberately does not stack (same trade-off as the border-status-editor
// example).
// ---------------------------------------------------------------------------

/** Subcommands whose second token is a mission id (mirrors cc-completions.ts). */
const MISSION_ID_SUBCOMMANDS: ReadonlySet<string> = new Set([
	"abort",
	"delete",
	"attach",
	"resume",
	"reply",
	"accept",
	"reject",
])

const CC_LINE = /^(\s*)(\/cc)(\s+)(\S+)(\s+\S+)?([\s\S]*)$/
const ID_AND_SPACE = /^(\s+)(\S+)/

/**
 * Colorize one rendered editor line when it starts with `/cc `.
 *
 * `fg` is `Theme.fg` (injected so the transform is unit-testable and so the
 * caller can resolve the *live* theme — the TUI theme can change at runtime
 * via `setTheme`). Non-command lines and the editor's border/autocomplete
 * lines are returned untouched. Cursor markers (`\x1b[7m…\x1b[0m`) may sit
 * inside a token while the cursor is on it; they are preserved verbatim.
 */
export function highlightCcLine(
	line: string,
	fg: (color: ThemeColor, text: string) => string,
): string {
	const m = CC_LINE.exec(line)
	if (!m) return line

	const pad = m[1] ?? ""
	const cc = m[2] ?? ""
	const space = m[3] ?? ""
	const subcommand = m[4] ?? ""
	const idAndSpace = m[5]
	const rest = m[6] ?? ""

	const colored =
		pad + fg("syntaxKeyword", cc) + space + fg("syntaxFunction", subcommand)

	if (!idAndSpace) return colored + rest

	// Free-form argument present (e.g. `/cc reject <id> <feedback>`): color the
	// mission id only for mission-id subcommands; leave the rest untouched.
	const idMatch = ID_AND_SPACE.exec(idAndSpace)
	const id = idMatch?.[2]
	if (id && MISSION_ID_SUBCOMMANDS.has(subcommand.toLowerCase())) {
		return colored + (idMatch?.[1] ?? "") + fg("syntaxString", id) + rest
	}
	return colored + idAndSpace + rest
}

class CcHighlightEditor extends CustomEditor {
	override render(width: number): string[] {
		const thm = CC_HIGHLIGHT_THEME
		return super
			.render(width)
			.map((line) => highlightCcLine(line, (c, t) => thm.fg(c, t)))
	}
}

/**
 * Live theme proxy resolved per render (theme can change via setTheme).
 * Assigned in the session_start handler; `Theme.fg` needs the TUI theme
 * initialized, which it is by the time the editor renders.
 */
let CC_HIGHLIGHT_THEME: { fg(color: ThemeColor, text: string): string } = {
	fg: (_color, text) => text,
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		CC_HIGHLIGHT_THEME = ctx.ui.theme
		ctx.ui.setEditorComponent(
			(tui, theme, keybindings) =>
				new CcHighlightEditor(tui, theme, keybindings),
		)
	})
}
