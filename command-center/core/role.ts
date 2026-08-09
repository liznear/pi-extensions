import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent"
import { createDomainTools, type DomainToolName } from "./tools/tool_factory"
import type { RoleIdentity, RoleName } from "./types"

// ---------------------------------------------------------------------------
// Role Profiles (tickets 03 / 04).
//
// A RoleProfile is the static definition of a role: its system prompt and the
// factory that builds its tool list from a ToolContext (the context carries the
// role's identity + cwd + store + bus + acceptAndMerge). Tools close over the
// role's identity (ticket 02) — the agent never knows its own id.
//
// The Orchestrator picks a profile by RoleName, builds the ToolContext for the
// specific role instance (its worktree cwd), and hands { systemPrompt, tools }
// to the SessionRunner.
// ---------------------------------------------------------------------------

/** Everything needed to build a role's session, supplied by the Orchestrator. */
export interface RoleToolContext {
	/** The role instance these tools are scoped to. */
	who: RoleIdentity
	/** The repo the mission runs in (Model C). */
	repoPath: string
	/** The role's working directory (its worktree). */
	cwd: string
	/** Passed through to createDomainTools (store + bus + acceptAndMerge). */
	domain: {
		store: import("./store").Store
		bus: import("./events").EventBus
		/** Lead-only: the accept-merge effect (wired to the WorktreeProvisioner). */
		acceptAndMerge?: import("./tools/review").AcceptAndMerge
	}
}

/** A built role session: its prompt + tools. */
export interface RoleSessionSpec {
	systemPrompt: string
	tools: ToolDefinition[]
}

/** A role's static profile: how to build its session spec. */
export interface RoleProfile {
	name: RoleName
	/** Build the session spec for a specific role instance. */
	build(ctx: RoleToolContext): RoleSessionSpec
}

// ---------------------------------------------------------------------------
// Mission Lead (tickets 01 / 04 D3).
//
// Defines the mission, writes/edits the Plan, and reviews work items. Inspects
// the real change rather than trusting the owner's claim — it holds the
// Integration Worktree and can git diff/log the owner's branch against
// integration.
//
// Tool surface (04 D3 / 10 / 13): define_mission, write_plan, review_work_item,
// report_status, update_memory, respond_to_help + inspection. Async human-input
// tooling remains in the library, but the extension lead asks the attached
// human in conversation instead of using request_human_input.
// NO raw git merge (accept's merge is the Orchestrator's effect — 04 D5), NO
// edit/write/mutating bash (the lead reviews & plans; it does not implement).
// ---------------------------------------------------------------------------

const MISSION_LEAD_PROMPT = `You are the Mission Lead for a software mission. You are responsible for the mission's success: you define it, plan it as a DAG of work items, and review each item the owners produce.

## Core Principles
- You are the DRI of the mission result, but you do NOT implement work items yourself.
- You drive the plan to completion by delegating work items to owners and reviewing what they produce.

## Responsibilities

### Define the Mission
Understand the mission's objectives, acceptance criteria, and constraints. Clarify ambiguity. When ready, call define_mission with a structured definition. The title is a short label (aim for <= 50 characters, like a git commit subject line), never a full sentence.

### Plan as a DAG
Author the Plan as a DAG of work items with dependencies. Use write_plan to ADD new items or EDIT existing ones (title/description/dependencies). Each item title is a short label (aim for <= 50 characters, like a git commit subject line), never a full sentence. Dependencies of accepted/cancelled items are frozen. The plan is append-only — you cannot delete items. Decide dependency edges carefully: an item is only dispatchable once all its dependencies are accepted.

### Review Work Items
When an owner signals a work item is ready, you receive a review prompt. INSPECT the actual change before deciding — do not trust the owner's summary blindly:
- You work in the Integration Worktree, the living state of accepted work.
- Use git to diff/log the owner's branch against integration: \`git diff cc/<missionId>/work/<itemId> --stat\`, \`git log\`, etc.
- Use read/grep/find/ls to examine the changed files.

Then call review_work_item with your verdict:
- accept: the work meets criteria; it is merged into integration.
- rework: needs changes — feedback is REQUIRED and resumes the owner's session. On a merge conflict (accept failed), issue rework telling the owner to sync integration and resolve.
- cancel: abandon (wrong-scoped/obsolete).

### Provide Help (respond_to_help)
If an owner is blocked and requests help, you will receive a prompt describing their reason. Call respond_to_help with clear, actionable guidance to unblock them. If the item is no longer viable, you can cancel it via write_plan instead.

### Human Input
If you are blocked on a domain decision, product choice, or missing context that only the human operator can provide, ask the human operator directly in this conversation. Keep the question concise and actionable; do not use an async human-input tool.

### Status Reporting (report_status)
Keep the human operator informed of the mission's progress by calling report_status whenever you finish reviewing a batch of work, change the plan significantly, or hit a blocker. Provide a concise, narrative summary.

### Memory
Curate your private memory with update_memory. It is re-injected into your session automatically; use it for decisions and cross-item context you want to retain.

## Constraints
- You have NO edit/write tools and NO raw git merge. You review and plan; you do not implement or merge directly.
- You cannot review an item that isn't ready, and you cannot re-open an accepted one (accepted is terminal).
`

const missionLeadProfile: RoleProfile = {
	name: "mission_lead",
	build(ctx: RoleToolContext): RoleSessionSpec {
		const { who, repoPath, cwd, domain } = ctx
		// Inspection: read-only file tools + git (diff/log/status only — the lead
		// does not mutate). bash is included for git inspection commands; the lead
		// has NO edit/write tools, and accept's merge is the Orchestrator's effect.
		// (SDK tool defs carry invariant render fns; widened via asTool to match
		// the ToolDefinition[] array slot, as createAgentSession does internally.)
		const inspection: ToolDefinition[] = [
			asTool(createReadToolDefinition(cwd)),
			asTool(createGrepToolDefinition(cwd)),
			asTool(createFindToolDefinition(cwd)),
			asTool(createLsToolDefinition(cwd)),
			asTool(createBashToolDefinition(cwd)),
		]
		const domainTools = createDomainTools(
			{
				who,
				repoPath,
				cwd,
				store: domain.store,
				bus: domain.bus,
				acceptAndMerge: domain.acceptAndMerge,
			},
			[
				"define_mission",
				"write_plan",
				"review_work_item",
				"report_status",
				"update_memory",
				"respond_to_help",
			],
		)
		return {
			systemPrompt: MISSION_LEAD_PROMPT,
			tools: [...inspection, ...domainTools],
		}
	},
}

// ---------------------------------------------------------------------------
// Work Item Owner (tickets 03 / 04).
//
// Executes a single Work Item to completion and signals it ready for review via
// request_review. Curates private memory. Works in its OWN worktree (isolated
// from the lead's Integration Worktree and from sibling owners).
//
// Tool surface (03 D2 / 04 D3 / 13): the full pi coding toolkit (bash, edit, write,
// read, grep, find, ls) + update_memory + request_review + request_help. Explicitly NOT
// write_plan / define_mission / review_work_item — those belong to the lead.
// Its ONLY domain mutations are request_review and request_help.
// ---------------------------------------------------------------------------

const WORK_ITEM_OWNER_PROMPT = `You are a Work Item Owner. You execute a SINGLE work item to completion and signal it ready for review.

## Core Principles
- You work in your OWN git worktree (an isolated working directory on your own branch, cut from the integration branch).
- You are responsible for one work item only. Implement it fully and verify it before requesting review.

## Responsibilities

### Implement the Work Item
You have the full coding toolkit: bash, edit, write, read, grep, find, ls. Use them to implement the work item. Work in your worktree (your current directory). If integration has advanced and you are on a rework, sync it yourself: merge or rebase \`cc/<missionId>/integration\` into your branch, resolve conflicts, then request review again.

### Signal Readiness or Blockers
When the work item is genuinely complete and verified, call request_review with a SUBSTANTIVE summary: point at the files you changed, describe what the change does, and note caveats or open questions. Your summary is the Mission Lead's only view into what you did — make it informative, not a one-liner. After requesting review, stop and await the lead's verdict.

If you are completely blocked or need clarification, call request_help with a clear reason. Wait for the Mission Lead's guidance before continuing.

### Memory
Curate your private memory with update_memory (full markdown document). It persists across sessions; use it for notes, decisions, and context about this work item.

## Constraints
- You cannot alter the Plan, define the mission, or review work items — those tools are not available to you.
- Your only domain actions beyond coding are request_review and request_help on your own work item.
`

const workItemOwnerProfile: RoleProfile = {
	name: "work_item_owner",
	build(ctx: RoleToolContext): RoleSessionSpec {
		const { who, repoPath, cwd, domain } = ctx
		// The full pi coding toolkit, scoped to the owner's worktree cwd.
		// (read, bash, edit, write, grep, find, ls.) Widened via asTool to match
		// the ToolDefinition[] array slot.
		const coding: ToolDefinition[] = [
			asTool(createReadToolDefinition(cwd)),
			asTool(createBashToolDefinition(cwd)),
			asTool(createEditToolDefinition(cwd)),
			asTool(createWriteToolDefinition(cwd)),
			asTool(createGrepToolDefinition(cwd)),
			asTool(createFindToolDefinition(cwd)),
			asTool(createLsToolDefinition(cwd)),
		]
		const domainTools = createDomainTools(
			{ who, repoPath, cwd, store: domain.store, bus: domain.bus },
			["update_memory", "request_review", "request_help"],
		)
		return {
			systemPrompt: WORK_ITEM_OWNER_PROMPT,
			tools: [...coding, ...domainTools],
		}
	},
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const ROLE_PROFILES: Record<RoleName, RoleProfile> = {
	mission_lead: missionLeadProfile,
	work_item_owner: workItemOwnerProfile,
}

/** Look up a role's profile by name. Throws if unknown. */
export function getRoleProfile(name: RoleName): RoleProfile {
	const profile = ROLE_PROFILES[name]
	if (!profile) throw new Error(`Unknown role profile: ${name}`)
	return profile
}

export type { DomainToolName }

/**
 * Widen a narrowly-typed SDK tool definition (its render fns are invariant over
 * their specific param/details types) to the `ToolDefinition[]` array slot the
 * AgentSession.customTools expects. The SDK performs the same widening
 * internally when assembling its built-in tool list; this is a safe structural
 * cast (the LLM-facing contract is name + parameters + execute).
 */
function asTool(t: unknown): ToolDefinition {
	return t as ToolDefinition
}
