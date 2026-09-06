import { afterEach, describe, expect, test } from "bun:test"
import {
	orcaRenameArgs,
	orcaTerminalHandle,
	renameOrcaTabTitle,
	resolveOrcaCliCommand,
} from "../orca-terminal-title"

const ENV_KEYS = [
	"ORCA_TERMINAL_HANDLE",
	"ORCA_CLI_COMMAND",
	"ORCA_DEV_REPO_ROOT",
] as const

afterEach(() => {
	for (const key of ENV_KEYS) delete process.env[key]
})

describe("orcaTerminalHandle", () => {
	test("returns the handle inside an Orca terminal", () => {
		process.env.ORCA_TERMINAL_HANDLE = "term_123"
		expect(orcaTerminalHandle()).toBe("term_123")
	})

	test("returns undefined outside Orca", () => {
		expect(orcaTerminalHandle()).toBeUndefined()
	})
})

describe("resolveOrcaCliCommand", () => {
	test("prefers ORCA_CLI_COMMAND", () => {
		process.env.ORCA_CLI_COMMAND = "/custom/orca"
		process.env.ORCA_DEV_REPO_ROOT = "/dev/orca"
		expect(resolveOrcaCliCommand()).toBe("/custom/orca")
	})

	test("uses orca-dev in a dev checkout", () => {
		process.env.ORCA_DEV_REPO_ROOT = "/dev/orca"
		expect(resolveOrcaCliCommand()).toBe("orca-dev")
	})

	test("falls back to orca", () => {
		expect(resolveOrcaCliCommand()).toBe("orca")
	})
})

describe("orcaRenameArgs", () => {
	test("targets the given handle with the title", () => {
		expect(orcaRenameArgs("term_123", "π - work")).toEqual([
			"terminal",
			"rename",
			"--terminal",
			"term_123",
			"--title",
			"π - work",
			"--json",
		])
	})
})

describe("renameOrcaTabTitle", () => {
	// Only the no-op paths run here; the exec path is verified against a live
	// Orca app and must not fire a real `orca` process from unit tests.
	test("is a no-op outside Orca terminals", () => {
		expect(() => renameOrcaTabTitle("title")).not.toThrow()
	})

	test("is a no-op for an empty title", () => {
		process.env.ORCA_TERMINAL_HANDLE = "term_123"
		expect(() => renameOrcaTabTitle("")).not.toThrow()
	})
})
