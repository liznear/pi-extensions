import { homedir } from "node:os"
import { join } from "node:path"
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import type { AutocompleteItem } from "@earendil-works/pi-tui"
import { type AgentProfile, loadAgentProfiles } from "./utils.js"

const AGENTS_DIR = join(homedir(), ".pi", "agent", "agents")
const DEFAULT_TOOLS = ["read", "bash", "edit", "write"]

type PersistedState = { activeAgentName?: string }

function buildToolsForAgent(pi: ExtensionAPI, agent: AgentProfile): string[] {
	if (!agent.allowedTools || agent.allowedTools.length === 0)
		return pi.getActiveTools()
	const all = new Set(pi.getAllTools().map((t) => t.name))
	return agent.allowedTools.filter((t) => all.has(t))
}

function selectDefaultAgent(
	profiles: AgentProfile[],
): AgentProfile | undefined {
	return profiles[0]
}

export default function agentExtension(pi: ExtensionAPI): void {
	let profiles: AgentProfile[] = []
	let activeAgentName: string | undefined
	let previousTools: string[] | null = null

	function getActiveProfile(): AgentProfile | undefined {
		if (!activeAgentName) return undefined
		return profiles.find((p) => p.name === activeAgentName)
	}

	function setActiveAgent(
		nameOrId: string,
		notify = true,
		ctx?: ExtensionContext,
	): boolean {
		const profile = profiles.find(
			(p) => p.name === nameOrId || p.id === nameOrId,
		)
		if (!profile) return false
		activeAgentName = profile.name
		pi.appendEntry("agent-extension", {
			activeAgentName,
		} satisfies PersistedState)
		if (notify && ctx?.ui)
			ctx.ui.notify(`Active agent: ${profile.name}`, "info")
		return true
	}

	function cycleAgent(ctx: ExtensionContext): void {
		if (profiles.length === 0) {
			ctx.ui.notify("No agents found in ~/.pi/agent/agents", "warning")
			return
		}
		const idx = Math.max(
			0,
			profiles.findIndex((p) => p.name === activeAgentName),
		)
		const next = profiles[(idx + 1) % profiles.length]
		setActiveAgent(next.name, true, ctx)
	}

	function refreshStatus(ctx: ExtensionContext): void {
		const active = getActiveProfile()
		ctx.ui.setStatus("agent-profile", active ? `🤖 ${active.name}` : undefined)
	}

	pi.registerCommand("agent", {
		description: "Manage agent profiles from ~/.pi/agent/agents",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const items: AutocompleteItem[] = []
			for (const profile of profiles) {
				if (profile.id.startsWith(prefix)) {
					items.push({
						value: profile.id,
						label: profile.id,
					})
				} else if (profile.name.startsWith(prefix)) {
					items.push({
						value: profile.name,
						label: profile.name,
					})
				}
			}
			const builtins = ["list", "next"]
			for (const b of builtins) {
				if (b.startsWith(prefix)) items.push({ value: b, label: b })
			}
			return items.length > 0 ? items : null
		},
		handler: async (args, ctx) => {
			const command = (args ?? "").trim()
			if (command === "" || command === "list") {
				const lines = profiles.map(
					(p) =>
						`${p.id} / ${p.name}${p.allowedTools ? ` tools=${p.allowedTools.join(",")}` : ""}`,
				)
				ctx.ui.notify(
					lines.length ? lines.join("\n") : "No agent profiles found",
					"info",
				)
				return
			}
			if (command === "next") {
				cycleAgent(ctx)
				refreshStatus(ctx)
				return
			}
			if (setActiveAgent(command, true, ctx)) {
				refreshStatus(ctx)
				return
			}
			ctx.ui.notify(`Unknown agent: ${command}`, "error")
		},
	})

	pi.registerShortcut("alt+p", {
		description: "Switch to next agent",
		handler: async (ctx) => {
			cycleAgent(ctx)
			refreshStatus(ctx)
		},
	})

	pi.on("session_start", async (_event, ctx) => {
		const loaded = await loadAgentProfiles(AGENTS_DIR)
		profiles = loaded.profiles
		for (const error of loaded.errors)
			ctx.ui.notify(`[agent-extension] ${error}`, "warning")

		const entries = ctx.sessionManager.getEntries()
		const state = entries
			.filter(
				(e: { type: string; customType?: string }) =>
					e.type === "custom" && e.customType === "agent-extension",
			)
			.pop() as { data?: PersistedState } | undefined
		activeAgentName = state?.data?.activeAgentName

		if (!getActiveProfile()) {
			const fallback = selectDefaultAgent(profiles)
			activeAgentName = fallback?.name
		}

		refreshStatus(ctx)
	})

	pi.on("before_agent_start", (event) => {
		const active = getActiveProfile()
		if (!active) return

		if (active.allowedTools && active.allowedTools.length > 0) {
			if (!previousTools) previousTools = pi.getActiveTools()
			pi.setActiveTools(buildToolsForAgent(pi, active))
		} else if (previousTools) {
			pi.setActiveTools(previousTools)
			previousTools = null
		}

		return {
			systemPrompt:
				event.systemPrompt +
				`\n\n[AGENT PROFILE ACTIVE]\nname: ${active.name}\n\n${active.systemPromptTemplate}`,
		}
	})

	pi.on("agent_end", () => {
		if (previousTools) {
			pi.setActiveTools(previousTools)
			previousTools = null
		} else {
			const active = getActiveProfile()
			if (!active?.allowedTools) {
				const current = pi.getActiveTools()
				if (current.length === 0) pi.setActiveTools(DEFAULT_TOOLS)
			}
		}
	})
}
