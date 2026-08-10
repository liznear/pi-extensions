import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent"
import type { EventBus } from "./events"
import {
	PiSessionRunner,
	PiVisibleLeadSessionRunner,
	type RoleSession,
	type SessionRunner,
} from "./session"
import type { Store } from "./store"
import type { RoleIdentity } from "./types"

const execFileAsync = promisify(execFile)

// ---------------------------------------------------------------------------
// Herdr CLI Abstraction
// ---------------------------------------------------------------------------

export interface HerdrPaneInfo {
	pane_id: string
	cwd: string
	focused?: boolean
	agent_status?: string
	[key: string]: unknown
}

export interface HerdrCli {
	isHerdrEnv(): boolean
	splitPane(opts: {
		cwd: string
		direction?: "right" | "down"
	}): Promise<string>
	listPanes(): Promise<HerdrPaneInfo[]>
	runInPane(paneId: string, command: string): Promise<void>
	sendText(paneId: string, text: string): Promise<void>
	closePane(paneId: string): Promise<void>
}

export class DefaultHerdrCli implements HerdrCli {
	isHerdrEnv(): boolean {
		return process.env.HERDR_ENV === "1"
	}

	async splitPane(opts: {
		cwd: string
		direction?: "right" | "down"
	}): Promise<string> {
		const args = [
			"pane",
			"split",
			"--cwd",
			opts.cwd,
			"--direction",
			opts.direction ?? "right",
			"--no-focus",
		]
		const { stdout } = await execFileAsync("herdr", args, { encoding: "utf8" })
		let parsed: Record<string, unknown> | null = null
		try {
			parsed = JSON.parse(stdout)
		} catch {
			throw new Error(
				`Failed to split herdr pane: invalid JSON response (${stdout})`,
			)
		}
		const result = parsed?.result as Record<string, unknown> | undefined
		const pane = result?.pane as Record<string, unknown> | undefined
		const paneId = pane?.pane_id
		if (typeof paneId !== "string") {
			throw new Error(
				`Failed to split herdr pane: invalid JSON response (${stdout})`,
			)
		}
		return paneId
	}

	async listPanes(): Promise<HerdrPaneInfo[]> {
		const { stdout } = await execFileAsync("herdr", ["pane", "list"], {
			encoding: "utf8",
		})
		let parsed: Record<string, unknown> | null = null
		try {
			parsed = JSON.parse(stdout)
		} catch {
			return []
		}
		const result = parsed?.result as Record<string, unknown> | undefined
		const panes = result?.panes
		if (!Array.isArray(panes)) {
			return []
		}
		return panes
	}

	async runInPane(paneId: string, command: string): Promise<void> {
		await execFileAsync("herdr", ["pane", "run", paneId, command], {
			encoding: "utf8",
		})
	}

	async sendText(paneId: string, text: string): Promise<void> {
		await execFileAsync("herdr", ["pane", "send-text", paneId, text], {
			encoding: "utf8",
		})
	}

	async closePane(paneId: string): Promise<void> {
		await execFileAsync("herdr", ["pane", "close", paneId], {
			encoding: "utf8",
		})
	}
}

// ---------------------------------------------------------------------------
// HerdrRoleSession
// ---------------------------------------------------------------------------

export interface HerdrRoleSessionOptions {
	who: RoleIdentity
	cwd: string
	paneId: string
	store: Store
	bus: EventBus
	herdrCli: HerdrCli
	pollIntervalMs?: number
}

export class HerdrRoleSession implements RoleSession {
	readonly sessionId: string
	private streaming = false
	private aborted = false
	private isFirstPrompt = true

	constructor(private readonly opts: HerdrRoleSessionOptions) {
		this.sessionId = `herdr:${opts.paneId}`
	}

	isStreaming(): boolean {
		return this.streaming
	}

	abort(): void {
		this.aborted = true
		this.streaming = false
	}

	async prompt(text: string): Promise<void> {
		this.streaming = true
		this.aborted = false

		const { who, cwd, paneId, store, herdrCli } = this.opts
		const pollInterval = this.opts.pollIntervalMs ?? 500

		// Ensure pane exists; if closed externally, re-split.
		const currentPanes = await herdrCli.listPanes().catch(() => [])
		const paneExists = currentPanes.some((p) => p.pane_id === paneId)
		let targetPaneId = paneId
		if (!paneExists) {
			targetPaneId = await herdrCli.splitPane({ cwd, direction: "right" })
		}

		// Execute prompt in pane
		if (this.isFirstPrompt) {
			this.isFirstPrompt = false
			// Escape prompt for shell or launch pi with initial prompt
			const escapedPrompt = text.replace(/"/g, '\\"')
			await herdrCli.runInPane(targetPaneId, `pi "${escapedPrompt}"`)
		} else {
			await herdrCli.sendText(targetPaneId, `${text}\n`)
		}

		// Option A: Poll FileStore for work item completion / status transition
		while (this.streaming && !this.aborted) {
			await new Promise((resolve) => setTimeout(resolve, pollInterval))
			if (!this.streaming || this.aborted) break

			const plan = await store.readPlan(who.missionId).catch(() => null)
			if (!plan) {
				break
			}

			const item = plan.items.find((i) => i.id === who.workItemId)
			if (item?.status !== "in_progress") {
				// Status moved away from in_progress (e.g. ready_for_review, completed, failed, cancelled)
				break
			}

			// Check if pane was closed by user
			const livePanes = await herdrCli.listPanes().catch(() => [])
			if (!livePanes.some((p) => p.pane_id === targetPaneId)) {
				break
			}
		}

		this.streaming = false
	}
}

// ---------------------------------------------------------------------------
// HerdrSessionRunner
// ---------------------------------------------------------------------------

export interface HerdrSessionRunnerOptions {
	bus: EventBus
	store: Store
	herdrCli?: HerdrCli
	pollIntervalMs?: number
}

export class HerdrSessionRunner implements SessionRunner {
	private readonly herdrCli: HerdrCli
	private readonly activePanes = new Map<string, string>()

	constructor(private readonly opts: HerdrSessionRunnerOptions) {
		this.herdrCli = opts.herdrCli ?? new DefaultHerdrCli()
	}

	async startOrResume(
		who: RoleIdentity,
		cwd: string,
		_systemPrompt: string,
		_tools: ToolDefinition[],
	): Promise<RoleSession> {
		const key = `${who.missionId}:${who.roleName}:${who.workItemId ?? ""}`

		// Check if an existing pane is still alive for this work item
		let paneId = this.activePanes.get(key)
		if (paneId) {
			const livePanes = await this.herdrCli.listPanes().catch(() => [])
			if (!livePanes.some((p) => p.pane_id === paneId)) {
				paneId = undefined
			}
		}

		if (!paneId) {
			paneId = await this.herdrCli.splitPane({ cwd, direction: "right" })
			this.activePanes.set(key, paneId)
		}

		this.opts.bus.emit({
			type: "session-started",
			missionId: who.missionId,
			roleName: who.roleName,
			...(who.workItemId !== undefined ? { workItemId: who.workItemId } : {}),
			sessionId: `herdr:${paneId}`,
		})

		return new HerdrRoleSession({
			who,
			cwd,
			paneId,
			store: this.opts.store,
			bus: this.opts.bus,
			herdrCli: this.herdrCli,
			pollIntervalMs: this.opts.pollIntervalMs,
		})
	}
}

// ---------------------------------------------------------------------------
// AutoSessionRunner / Factory
// ---------------------------------------------------------------------------

export interface AutoSessionRunnerOptions {
	bus: EventBus
	store: Store
	pi?: ExtensionAPI
	getContext?: () => ExtensionContext | undefined
	resolveVisibleRole?: (
		ctx: ExtensionContext,
	) => Promise<RoleIdentity | undefined>
	fallbackRunner?: SessionRunner
	herdrRunner?: SessionRunner
	isHerdrEnv?: () => boolean
}

export class AutoSessionRunner implements SessionRunner {
	private readonly fallbackRunner: SessionRunner
	private readonly herdrRunner: SessionRunner
	private readonly isHerdrEnvFn: () => boolean

	constructor(opts: AutoSessionRunnerOptions) {
		this.isHerdrEnvFn = opts.isHerdrEnv ?? (() => process.env.HERDR_ENV === "1")

		this.fallbackRunner =
			opts.fallbackRunner ??
			(opts.pi && opts.getContext && opts.resolveVisibleRole
				? new PiVisibleLeadSessionRunner({
						bus: opts.bus,
						store: opts.store,
						pi: opts.pi,
						getContext: opts.getContext,
						resolveVisibleRole: opts.resolveVisibleRole,
					})
				: new PiSessionRunner({ bus: opts.bus, store: opts.store }))

		this.herdrRunner =
			opts.herdrRunner ??
			new HerdrSessionRunner({ bus: opts.bus, store: opts.store })
	}

	async startOrResume(
		who: RoleIdentity,
		cwd: string,
		systemPrompt: string,
		tools: ToolDefinition[],
	): Promise<RoleSession> {
		const isHerdr = this.isHerdrEnvFn()

		// Herdr pane runner is used specifically for work_item_owner sessions when running in Herdr
		if (isHerdr && who.roleName === "work_item_owner") {
			return this.herdrRunner.startOrResume(who, cwd, systemPrompt, tools)
		}

		return this.fallbackRunner.startOrResume(who, cwd, systemPrompt, tools)
	}
}

export function createAutoSessionRunner(
	opts: AutoSessionRunnerOptions,
): SessionRunner {
	return new AutoSessionRunner(opts)
}
