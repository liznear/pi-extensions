import { describe, expect, test } from "bun:test"
import {
	formatTerminalActivityTitle,
	formatTerminalTitle,
} from "../cc-terminal-status"

describe("terminal status titles", () => {
	test("formats the default terminal title", () => {
		expect(formatTerminalTitle(undefined, "/repo/project")).toBe("π - project")
	})

	test("includes the session name and working directory", () => {
		expect(formatTerminalTitle("Build API", "/repo/project")).toBe(
			"π - Build API - project",
		)
	})

	test("uses a spinner prefix for a working mission", () => {
		expect(formatTerminalActivityTitle("π - Build API - project", true)).toBe(
			"⠋ π - Build API - project",
		)
	})

	test("restores the base title when the mission is idle", () => {
		expect(formatTerminalActivityTitle("π - Build API - project", false)).toBe(
			"π - Build API - project",
		)
	})
})
