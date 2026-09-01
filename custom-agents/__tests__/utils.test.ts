import { describe, expect, it } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadAgentProfiles } from "../utils.js"

describe("custom-agents utils", () => {
	it("loads agent profiles and parses frontmatter correctly", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "custom-agents-test-"))
		try {
			await writeFile(
				join(tempDir, "plan.md"),
				`---
name: plan
allowed_tools: [read, bash, grep]
---

You are in planning mode.
`,
				"utf8",
			)
			await writeFile(
				join(tempDir, "build.md"),
				`---
name: build
allowed_tools:
  - read
  - write
---

You are in build mode.
`,
				"utf8",
			)

			const { profiles, errors } = await loadAgentProfiles(tempDir)
			expect(errors).toHaveLength(0)
			expect(profiles).toHaveLength(2)

			const plan = profiles.find((p) => p.name === "plan")
			expect(plan).toBeDefined()
			expect(plan?.id).toBe("plan")
			expect(plan?.allowedTools).toEqual(["read", "bash", "grep"])
			expect(plan?.systemPromptTemplate).toBe("You are in planning mode.")

			const build = profiles.find((p) => p.name === "build")
			expect(build).toBeDefined()
			expect(build?.id).toBe("build")
			expect(build?.allowedTools).toEqual(["read", "write"])
			expect(build?.systemPromptTemplate).toBe("You are in build mode.")
		} finally {
			await rm(tempDir, { recursive: true, force: true })
		}
	})

	it("handles missing name and duplicate names", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "custom-agents-test-"))
		try {
			await writeFile(
				join(tempDir, "no-name.md"),
				`---
allowed_tools: [read]
---

No name here.
`,
				"utf8",
			)
			await writeFile(
				join(tempDir, "agent1.md"),
				`---
name: duplicate
---

Agent 1
`,
				"utf8",
			)
			await writeFile(
				join(tempDir, "agent2.md"),
				`---
name: duplicate
---

Agent 2
`,
				"utf8",
			)

			const { profiles, errors } = await loadAgentProfiles(tempDir)
			expect(
				errors.some((e) =>
					e.includes("missing required frontmatter field 'name'"),
				),
			).toBe(true)
			expect(
				errors.some((e) => e.includes("Duplicate agent name: 'duplicate'")),
			).toBe(true)
			expect(profiles).toHaveLength(2)
		} finally {
			await rm(tempDir, { recursive: true, force: true })
		}
	})
})
