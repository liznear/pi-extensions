import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { ToolDefinition } from "@earendil-works/pi-coding-agent"
import type { EventBus } from "./events"
import type { RoleSession, SessionRunner } from "./session"
import type { Store } from "./store"
import type { RoleIdentity } from "./types"

const execFileAsync = promisify(execFile)

/**
 * Resolves the appropriate Orca CLI binary based on environment context.
 */
export function resolveOrcaCliCommand(): string {
	if (process.env.ORCA_CLI_COMMAND) {
		return process.env.ORCA_CLI_COMMAND
	}
	if (process.env.ORCA_DEV_REPO_ROOT) {
		return "orca-dev"
	}
	if (
		process.platform === "linux" &&
		!process.env.ORCA_TERMINAL_HANDLE &&
		!process.env.ORCA_WORKTREE_ID
	) {
		return "orca-ide"
	}
	return "orca"
}

/**
 * Checks whether the current process is running inside an Orca environment.
 */
export function isOrcaEnv(): boolean {
	return Boolean(
		process.env.ORCA_ENV === "1" ||
			process.env.ORCA_WORKTREE_ID ||
			process.env.ORCA_TERMINAL_HANDLE ||
			process.env.ORCA_WORKSPACE_ID,
	)
}

// ---------------------------------------------------------------------------
// Orca CLI Abstraction
// ---------------------------------------------------------------------------

export interface OrcaTerminalInfo {
	handle: string
	worktreePath?: string
	title?: string
	connected?: boolean
	[key: string]: unknown
}

export interface OrcaCli {
	isOrcaEnv(): boolean
	createTerminal(opts: {
		cwd: string
		title?: string
		command?: string
	}): Promise<string>
	splitTerminal(opts: {
		terminalHandle?: string
		direction?: "horizontal" | "vertical"
		command?: string
	}): Promise<string>
	listTerminals(): Promise<OrcaTerminalInfo[]>
	sendText(terminalHandle: string, text: string, enter?: boolean): Promise<void>
	closeTerminal(terminalHandle: string): Promise<void>
}

export class DefaultOrcaCli implements OrcaCli {
	private readonly cliCmd: string

	constructor(cliCmd?: string) {
		this.cliCmd = cliCmd ?? resolveOrcaCliCommand()
	}

	isOrcaEnv(): boolean {
		return isOrcaEnv()
	}

	async createTerminal(opts: {
		cwd: string
		title?: string
		command?: string
	}): Promise<string> {
		const args = [
			"terminal",
			"create",
			"--worktree",
			`path:${opts.cwd}`,
			...(opts.title ? ["--title", opts.title] : []),
			...(opts.command ? ["--command", opts.command] : []),
			"--json",
		]
		const { stdout } = await execFileAsync(this.cliCmd, args, {
			encoding: "utf8",
		})
		let parsed: Record<string, unknown> | null = null
		try {
			parsed = JSON.parse(stdout)
		} catch {
			throw new Error(
				`Failed to create Orca terminal: invalid JSON response (${stdout})`,
			)
		}
		const result = parsed?.result as Record<string, unknown> | undefined
		const terminal = result?.terminal as Record<string, unknown> | undefined
		const handle = terminal?.handle
		if (typeof handle !== "string") {
			throw new Error(
				`Failed to create Orca terminal: invalid JSON response (${stdout})`,
			)
		}
		return handle
	}

	async splitTerminal(opts: {
		terminalHandle?: string
		direction?: "horizontal" | "vertical"
		command?: string
	}): Promise<string> {
		const args = [
			"terminal",
			"split",
			...(opts.terminalHandle ? ["--terminal", opts.terminalHandle] : []),
			...(opts.direction ? ["--direction", opts.direction] : []),
			...(opts.command ? ["--command", opts.command] : []),
			"--json",
		]
		const { stdout } = await execFileAsync(this.cliCmd, args, {
			encoding: "utf8",
		})
		let parsed: Record<string, unknown> | null = null
		try {
			parsed = JSON.parse(stdout)
		} catch {
			throw new Error(
				`Failed to split Orca terminal: invalid JSON response (${stdout})`,
			)
		}
		const result = parsed?.result as Record<string, unknown> | undefined
		const split = result?.split as Record<string, unknown> | undefined
		const handle = split?.handle
		if (typeof handle !== "string") {
			throw new Error(
				`Failed to split Orca terminal: invalid JSON response (${stdout})`,
			)
		}
		return handle
	}

	async listTerminals(): Promise<OrcaTerminalInfo[]> {
		const args = ["terminal", "list", "--json"]
		try {
			const { stdout } = await execFileAsync(this.cliCmd, args, {
				encoding: "utf8",
			})
			const parsed = JSON.parse(stdout) as Record<string, unknown>
			const result = parsed?.result as Record<string, unknown> | undefined
			const terminals = result?.terminals
			if (!Array.isArray(terminals)) {
				return []
			}
			return terminals as OrcaTerminalInfo[]
		} catch {
			return []
		}
	}

	async sendText(
		terminalHandle: string,
		text: string,
		enter = true,
	): Promise<void> {
		const args = [
			"terminal",
			"send",
			"--terminal",
			terminalHandle,
			"--text",
			text,
			...(enter ? ["--enter"] : []),
			"--json",
		]
		await execFileAsync(this.cliCmd, args, { encoding: "utf8" })
	}

	async closeTerminal(terminalHandle: string): Promise<void> {
		const args = ["terminal", "close", "--terminal", terminalHandle, "--json"]
		await execFileAsync(this.cliCmd, args, { encoding: "utf8" })
	}
}

// ---------------------------------------------------------------------------
// OrcaRoleSession
// ---------------------------------------------------------------------------

export interface OrcaRoleSessionOptions {
	who: RoleIdentity
	cwd: string
	terminalHandle: string
	store: Store
	bus: EventBus
	orcaCli: OrcaCli
	pollIntervalMs?: number
}

export class OrcaRoleSession implements RoleSession {
	readonly sessionId: string
	private streaming = false
	private aborted = false
	private isFirstPrompt = true

	constructor(private readonly opts: OrcaRoleSessionOptions) {
		this.sessionId = `orca:${opts.terminalHandle}`
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

		const { who, cwd, terminalHandle, store, orcaCli, bus } = this.opts
		const pollInterval = this.opts.pollIntervalMs ?? 500

		// Ensure terminal exists; if closed externally, re-create.
		const currentTerminals = await orcaCli.listTerminals().catch(() => [])
		const terminalExists = currentTerminals.some(
			(t) => t.handle === terminalHandle,
		)
		let targetHandle = terminalHandle
		if (!terminalExists) {
			targetHandle = await orcaCli.createTerminal({ cwd })
		}

		// Execute prompt in terminal
		if (this.isFirstPrompt) {
			this.isFirstPrompt = false
			// Escape prompt for shell or launch pi with initial prompt
			const escapedPrompt = text.replace(/"/g, '\\"')
			await orcaCli.sendText(targetHandle, `pi "${escapedPrompt}"`, true)
		} else {
			await orcaCli.sendText(targetHandle, text, true)
		}

		let toolEnded = false
		const off = bus.subscribe((e) => {
			if ("roleName" in e && "workItemId" in e) {
				if (
					e.missionId === who.missionId &&
					e.roleName === who.roleName &&
					e.workItemId === who.workItemId
				) {
					if (
						e.type === "tool-call-ended" &&
						(e.toolName === "request_review" || e.toolName === "request_help")
					) {
						toolEnded = true
					}
				}
			}
		})

		try {
			// Poll FileStore for work item completion / status transition
			while (this.streaming && !this.aborted && !toolEnded) {
				await new Promise((resolve) => setTimeout(resolve, pollInterval))
				if (!this.streaming || this.aborted || toolEnded) break

				const plan = await store.readPlan(who.missionId).catch(() => null)
				if (!plan) {
					break
				}

				const item = plan.items.find((i) => i.id === who.workItemId)
				if (item?.status !== "in_progress") {
					// Status moved away from in_progress
					break
				}

				// Check if terminal was closed by user
				const liveTerminals = await orcaCli.listTerminals().catch(() => [])
				if (!liveTerminals.some((t) => t.handle === targetHandle)) {
					break
				}
			}
		} finally {
			off()
		}

		this.streaming = false
	}
}

// ---------------------------------------------------------------------------
// OrcaSessionRunner
// ---------------------------------------------------------------------------

export interface OrcaSessionRunnerOptions {
	bus: EventBus
	store: Store
	orcaCli?: OrcaCli
	pollIntervalMs?: number
}

export class OrcaSessionRunner implements SessionRunner {
	private readonly orcaCli: OrcaCli
	private readonly activeTerminals = new Map<string, string>()

	constructor(private readonly opts: OrcaSessionRunnerOptions) {
		this.orcaCli = opts.orcaCli ?? new DefaultOrcaCli()
	}

	async startOrResume(
		who: RoleIdentity,
		cwd: string,
		_systemPrompt: string,
		_tools: ToolDefinition[],
	): Promise<RoleSession> {
		const key = `${who.missionId}:${who.roleName}:${who.workItemId ?? ""}`

		// Check if an existing terminal is still alive for this work item
		let handle = this.activeTerminals.get(key)
		if (handle) {
			const liveTerminals = await this.orcaCli.listTerminals().catch(() => [])
			if (!liveTerminals.some((t) => t.handle === handle)) {
				handle = undefined
			}
		}

		if (!handle) {
			handle = await this.orcaCli.createTerminal({ cwd })
			this.activeTerminals.set(key, handle)
		}

		this.opts.bus.emit({
			type: "session-started",
			missionId: who.missionId,
			roleName: who.roleName,
			...(who.workItemId !== undefined ? { workItemId: who.workItemId } : {}),
			sessionId: `orca:${handle}`,
		})

		return new OrcaRoleSession({
			who,
			cwd,
			terminalHandle: handle,
			store: this.opts.store,
			bus: this.opts.bus,
			orcaCli: this.orcaCli,
			pollIntervalMs: this.opts.pollIntervalMs,
		})
	}
}
