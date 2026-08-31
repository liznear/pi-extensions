import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * Scaffold-level check (ticket 09): both templates ship, declare version 1,
 * reference only prompt files that exist, and every prompt carries the
 * MANDATORY-emit paragraph (spike lesson S2 — a prompt that doesn't name emit
 * produces actors that never emit).
 */

const templatesDir = join(import.meta.dir, "..", "templates")
const templateDirs = readdirSync(templatesDir).filter((d) =>
	existsSync(join(templatesDir, d, `${d}.yaml`)),
)

describe("shipped templates", () => {
	test("both templates ship", () => {
		expect(templateDirs.sort()).toEqual(["pair", "review-pipeline"])
	})

	for (const dir of templateDirs) {
		test(`${dir}: version 1 + prompt references resolve`, () => {
			const yaml = readFileSync(join(templatesDir, dir, `${dir}.yaml`), "utf8")
			expect(yaml).toMatch(/^version: 1$/m)
			const refs = [...yaml.matchAll(/system_prompt_file:\s*(\S+)/g)].map(
				(m) => m[1]!,
			)
			expect(refs.length).toBeGreaterThan(0)
			for (const ref of refs) {
				expect(existsSync(join(templatesDir, dir, ref))).toBe(true)
			}
		})

		test(`${dir}: every prompt mandates emit (lesson S2)`, () => {
			const promptsDir = join(templatesDir, dir, "prompts")
			for (const file of readdirSync(promptsDir)) {
				const prompt = readFileSync(join(promptsDir, file), "utf8")
				expect(prompt).toContain('MANDATORY: you have a tool named "emit"')
			}
		})
	}
})
