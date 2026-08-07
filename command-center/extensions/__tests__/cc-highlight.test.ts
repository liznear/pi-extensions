import { describe, expect, test } from "bun:test"
import type { ThemeColor } from "@earendil-works/pi-coding-agent"
import { highlightCcLine } from "../cc-highlight"

// ---------------------------------------------------------------------------
// Stub fg: renders exactly what the transform asked for, without ANSI noise.
// ---------------------------------------------------------------------------

const fg = (color: ThemeColor, text: string) => `<${color}>${text}</${color}>`

// ---------------------------------------------------------------------------
// /cc command lines
// ---------------------------------------------------------------------------

describe("highlightCcLine — /cc command lines", () => {
	test("colors the /cc prefix and the subcommand", () => {
		expect(highlightCcLine("/cc attach", fg)).toBe(
			"<syntaxKeyword>/cc</syntaxKeyword> <syntaxFunction>attach</syntaxFunction>",
		)
	})

	test("colors the mission id for mission-id subcommands", () => {
		expect(highlightCcLine("/cc attach mission-1", fg)).toBe(
			"<syntaxKeyword>/cc</syntaxKeyword> <syntaxFunction>attach</syntaxFunction> <syntaxString>mission-1</syntaxString>",
		)
	})

	test("mission-id matching is case-insensitive", () => {
		expect(highlightCcLine("/cc ABORT MISSION-2", fg)).toContain(
			"<syntaxString>MISSION-2</syntaxString>",
		)
	})

	test("start/list do not color a second token (free-form argument)", () => {
		expect(highlightCcLine("/cc start add a test", fg)).toBe(
			"<syntaxKeyword>/cc</syntaxKeyword> <syntaxFunction>start</syntaxFunction> add a test",
		)
	})

	test("keeps text after the mission id untouched", () => {
		expect(highlightCcLine("/cc reject mission-1 too vague", fg)).toBe(
			"<syntaxKeyword>/cc</syntaxKeyword> <syntaxFunction>reject</syntaxFunction> <syntaxString>mission-1</syntaxString> too vague",
		)
	})

	test("trailing space after the subcommand colors only the prefix + subcommand", () => {
		expect(highlightCcLine("/cc attach ", fg)).toBe(
			"<syntaxKeyword>/cc</syntaxKeyword> <syntaxFunction>attach</syntaxFunction> ",
		)
	})

	test("preserves editor padding before the command", () => {
		expect(highlightCcLine("  /cc focus mission-1", fg)).toBe(
			"  <syntaxKeyword>/cc</syntaxKeyword> <syntaxFunction>focus</syntaxFunction> <syntaxString>mission-1</syntaxString>",
		)
	})
})

// ---------------------------------------------------------------------------
// Non-command lines pass through untouched
// ---------------------------------------------------------------------------

describe("highlightCcLine — passthrough", () => {
	test("bare /cc with no space is left alone", () => {
		expect(highlightCcLine("/cc", fg)).toBe("/cc")
	})

	test("plain message lines are unchanged", () => {
		expect(highlightCcLine("I typed /cc attach but it's a sentence", fg)).toBe(
			"I typed /cc attach but it's a sentence",
		)
	})

	test("border and empty lines are unchanged", () => {
		expect(highlightCcLine("────────────────", fg)).toBe("────────────────")
		expect(highlightCcLine("", fg)).toBe("")
	})

	test("wrapped continuation lines are unchanged", () => {
		expect(highlightCcLine("a long feedback message that wrapped", fg)).toBe(
			"a long feedback message that wrapped",
		)
	})

	test("cursor marker inside a token is preserved verbatim", () => {
		// Editor renders the cursor under the 't' of "attach" as inverse video.
		const line = "/cc at\x1b[7mt\x1b[0m"
		expect(highlightCcLine(line, fg)).toContain("at\x1b[7mt\x1b[0m")
	})
})
