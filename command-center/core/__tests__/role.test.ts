import { describe, expect, test } from "bun:test"
import { EventBus } from "../events"
import {
	type DomainToolName,
	getRoleProfile,
	ROLE_PROFILES,
	type RoleToolContext,
} from "../role"
import { InMemoryStore } from "../store"
import type { RoleIdentity } from "../types"

// We build each profile with a real InMemoryStore + EventBus and assert the
// tool surface (ticket 03 D2 / 04 D3) and prompt content.

function ctx(who: RoleIdentity): RoleToolContext {
	return {
		who,
		repoPath: "/test-repo",
		cwd: "/tmp/test",
		domain: {
			store: new InMemoryStore(),
			bus: new EventBus(),
			// The lead profile requests review_work_item, which needs an accept-merge
			// effect. A no-op stub is fine — these tests only inspect the tool surface.
			acceptAndMerge: async () => ({ ok: true }),
		},
	}
}

function toolNames(spec: { tools: { name: string }[] }): Set<string> {
	return new Set(spec.tools.map((t) => t.name))
}

const DOMAIN_TOOLS: DomainToolName[] = [
	"define_mission",
	"write_plan",
	"update_memory",
	"request_review",
	"review_work_item",
	"request_human_input",
	"report_status",
	"request_help",
	"respond_to_help",
]

describe("ROLE_PROFILES registry", () => {
	test("has exactly the two slice roles", () => {
		expect(Object.keys(ROLE_PROFILES).sort()).toEqual([
			"mission_lead",
			"work_item_owner",
		])
	})
})

describe("mission_lead profile", () => {
	const lead: RoleIdentity = { missionId: "7k3a9fqa", roleName: "mission_lead" }
	const profile = getRoleProfile("mission_lead")

	test("has the domain tools the lead owns (04 D3 / 13)", () => {
		const names = toolNames(profile.build(ctx(lead)))
		expect(names.has("define_mission")).toBe(true)
		expect(names.has("write_plan")).toBe(true)
		expect(names.has("review_work_item")).toBe(true)
		expect(names.has("update_memory")).toBe(true) // tool name unified to snake_case (was camelCase per ticket 02)
		expect(names.has("report_status")).toBe(true)
		expect(names.has("respond_to_help")).toBe(true)
	})

	test("has inspection tools: read, grep, find, ls, bash (04 D3)", () => {
		const names = toolNames(profile.build(ctx(lead)))
		for (const t of ["read", "grep", "find", "ls", "bash"]) {
			expect(names.has(t)).toBe(true)
		}
	})

	test("does NOT have edit / write (the lead does not implement)", () => {
		const names = toolNames(profile.build(ctx(lead)))
		expect(names.has("edit")).toBe(false)
		expect(names.has("write")).toBe(false)
	})

	test("does NOT have request_review (that's an owner tool)", () => {
		const names = toolNames(profile.build(ctx(lead)))
		expect(names.has("request_review")).toBe(false)
	})

	test("does NOT have request_human_input (the attached human answers in conversation)", () => {
		const names = toolNames(profile.build(ctx(lead)))
		expect(names.has("request_human_input")).toBe(false)
	})

	test("prompt instructs inspection-before-verdict + forbids merging", () => {
		const prompt = profile.build(ctx(lead)).systemPrompt
		expect(prompt).toContain("Mission Lead")
		expect(prompt).toMatch(/inspect/i)
		expect(prompt).toMatch(/review_work_item/)
		// the lead is explicitly told it has NO raw merge (the accept merge is the
		// Orchestrator's effect) — the constraint line forbids merging.
		expect(prompt).toMatch(/no raw git merge/i)
	})
})

describe("work_item_owner profile", () => {
	const owner: RoleIdentity = {
		missionId: "7k3a9fqa",
		roleName: "work_item_owner",
		workItemId: 1,
	}
	const profile = getRoleProfile("work_item_owner")

	test("has the full coding toolkit (03 D2)", () => {
		const names = toolNames(profile.build(ctx(owner)))
		for (const t of ["read", "bash", "edit", "write", "grep", "find", "ls"]) {
			expect(names.has(t)).toBe(true)
		}
	})

	test("has update_memory + request_review + request_help", () => {
		const names = toolNames(profile.build(ctx(owner)))
		expect(names.has("update_memory")).toBe(true)
		expect(names.has("request_review")).toBe(true)
		expect(names.has("request_help")).toBe(true)
	})

	test("does NOT have define_mission / write_plan / review_work_item (03 D5)", () => {
		const names = toolNames(profile.build(ctx(owner)))
		expect(names.has("define_mission")).toBe(false)
		expect(names.has("write_plan")).toBe(false)
		expect(names.has("review_work_item")).toBe(false)
	})

	test("prompt instructs substantive review summary + own worktree", () => {
		const prompt = profile.build(ctx(owner)).systemPrompt
		expect(prompt).toContain("Work Item Owner")
		expect(prompt).toMatch(/request_review/)
		expect(prompt).toMatch(/substantive/i)
		expect(prompt).toMatch(/worktree|isolated/i)
	})
})

describe("getRoleProfile", () => {
	test("returns the profile for a known role name", () => {
		expect(getRoleProfile("mission_lead").name).toBe("mission_lead")
		expect(getRoleProfile("work_item_owner").name).toBe("work_item_owner")
	})

	test("throws on an unknown role name", () => {
		expect(() => getRoleProfile("code_reviewer" as never)).toThrow(
			/Unknown role profile/,
		)
	})
})

// Ensure the DomainToolName re-export is exercised.
void DOMAIN_TOOLS
