import type { AssistantMessage } from "@earendil-works/pi-ai"
import {
	type AgentSessionEvent,
	type AgentSessionEventListener,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	SessionManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent"
import type { EmittableEvent, EventBus } from "./events"
import type { Store } from "./store"
import type { RoleIdentity, RoleName } from "./types"

// ---------------------------------------------------------------------------
// SessionRunner (tickets 03 / 04).
//
// The swappable seam between the library and the pi SDK: acquire a session for
// a role (resume | fresh — default policy is resume, ticket 03 D3 / 04 D1),
// inject memory, prompt it, and normalize its raw events into the library's
// own event vocabulary (ticket 01).
//
// A consumer can substitute a fresh-session policy or a fully-fake runner for
// tests; the Orchestrator is constructed with whichever SessionRunner it wants.
// ---------------------------------------------------------------------------

/** A handle on one role's live session. */
export interface RoleSession {
	/** The pi SDK session id (thread). */
	sessionId: string
	/** Send a prompt to the session (one agent turn). Resolves when idle. */
	prompt(text: string): Promise<void>
	/** Whether the session is currently processing. */
	isStreaming(): boolean
	/** Abort the currently processing turn. */
	abort(): void
}

/** The swappable seam. */
export interface SessionRunner {
	/**
	 * Acquire (resume | fresh) a session for a role, building its tools from
	 * `tools`. Memory is injected at session start (and survives compaction —
	 * see buildSystemPrompt). Emits `session-started`. `cwd` is the role's
	 * worktree directory (Model C: the Orchestrator resolves repoPath → cwd).
	 */
	startOrResume(
		who: RoleIdentity,
		cwd: string,
		systemPrompt: string,
		tools: ToolDefinition[],
	): Promise<RoleSession>
}

// ---------------------------------------------------------------------------
// normalizePiEvent (ticket 01).
//
// Re-wrap a single pi SDK AgentSessionEvent into the library's own vocabulary,
// identity-stamped with the role. Returns null for events the slice doesn't
// surface (content-block ends, compaction lifecycle, queue/turn plumbing).
//
// The forwarded set (ticket 01):
//   message_update → message-delta | reasoning-delta (by assistantMessageEvent.type)
//   tool_execution_start → tool-call-started
//   tool_execution_end   → tool-call-ended
//   message_end (assistant) → message-ended
//   agent_end → session-ended (turn boundary)
// ---------------------------------------------------------------------------

const SKIP_MESSAGE_UPDATE_TYPES = new Set([
	"start",
	"text_start",
	"text_end",
	"thinking_start",
	"thinking_end",
	"toolcall_start",
])

/** Role-identity fragment shared by every normalized event. */
interface RoleRef {
	missionId: string
	roleName: RoleName
	workItemId?: number
}

/** Build the identity fragment carried by every role-scoped event. */
function roleRef(who: RoleIdentity): RoleRef {
	const ref: RoleRef = { missionId: who.missionId, roleName: who.roleName }
	if (who.workItemId !== undefined) ref.workItemId = who.workItemId
	return ref
}

/** Pure: map one pi SDK event to one library event (or null). */
export function normalizePiEvent(
	who: RoleIdentity,
	sessionId: string,
	event: AgentSessionEvent,
): EmittableEvent | null {
	switch (event.type) {
		case "message_update": {
			const t = event.assistantMessageEvent.type
			if (t === "text_delta") {
				return {
					type: "message-delta",
					...roleRef(who),
					delta: event.assistantMessageEvent.delta,
				}
			}
			if (t === "thinking_delta") {
				return {
					type: "reasoning-delta",
					...roleRef(who),
					delta: event.assistantMessageEvent.delta,
				}
			}
			// Skip content-block starts/ends — redundant with deltas (ticket 01).
			if (SKIP_MESSAGE_UPDATE_TYPES.has(t)) return null
			return null
		}
		case "tool_execution_start":
			return {
				type: "tool-call-started",
				...roleRef(who),
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
			}
		case "tool_execution_end":
			return {
				type: "tool-call-ended",
				...roleRef(who),
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: event.result,
				isError: event.isError,
			}
		case "message_end": {
			const message = event.message as AssistantMessage | undefined
			// ticket 01: assistant-role only; tool-result message_ends are already
			// covered by tool-call-ended.
			if (message && message.role === "assistant") {
				return {
					type: "message-ended",
					...roleRef(who),
					message,
				}
			}
			return null
		}
		case "agent_end":
			return {
				type: "session-ended",
				...roleRef(who),
				sessionId,
			}
		default:
			// turn_start/end, queue_update, compaction_*, auto_retry_*, etc.
			return null
	}
}

// ---------------------------------------------------------------------------
// Memory injection (ticket 02 + ticket 03 amend).
//
// Memory is injected into the SYSTEM PROMPT, not as a transient user message.
// Why: the system prompt is re-sent on every turn and is never compacted away,
// so the once-injected-at-start doc survives compaction automatically — no
// separate re-injection mechanism needed (ticket 03's amend concern is
// satisfied for free, since the SDK auto-compaction only summarizes the
// message history, never the system prompt). Per-role docs are small in the
// slice.
// ---------------------------------------------------------------------------

export function buildSystemPrompt(
	base: string,
	store: Store,
): (who: RoleIdentity) => Promise<string> {
	return async (who: RoleIdentity) => {
		const memory = await store.readMemory(who)
		if (!memory) return base
		return `${base}\n\n## Your Memory\n\n${memory}`
	}
}

// ---------------------------------------------------------------------------
// PiSessionRunner — the default SessionRunner, backed by the pi SDK.
//
// Resume is automatic: createAgentSession({cwd}) resumes if the cwd's
// SessionManager has existing messages (no explicit flag). Each role runs in
// its OWN worktree cwd, so its session history is isolated per role → resume
// "just works" per (mission, role, work item).
//
// The constructor takes a `cwdFor(who)` function so the Orchestrator can map a
// RoleIdentity to its worktree directory (lead → integration worktree;
// owner → owner worktree).
// ---------------------------------------------------------------------------

export interface PiSessionRunnerOptions {
	store: Store
	bus: EventBus
}

export class PiSessionRunner implements SessionRunner {
	constructor(private readonly opts: PiSessionRunnerOptions) {}

	async startOrResume(
		who: RoleIdentity,
		cwd: string,
		systemPrompt: string,
		tools: ToolDefinition[],
	): Promise<RoleSession> {
		const { store, bus } = this.opts

		// Inject memory into the system prompt (survives compaction).
		const promptBuilder = buildSystemPrompt(systemPrompt, store)
		const fullSystemPrompt = await promptBuilder(who)

		// The SDK injects the system prompt via the resource-loader/services path
		// (createAgentSession itself exposes no systemPrompt option). We use the
		// runtime-factory form so the role's prompt + customTools are wired in.
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({
			cwd,
			sessionManager,
			sessionStartEvent,
		}) => {
			const services = await createAgentSessionServices({
				cwd,
				resourceLoaderOptions: {
					noExtensions: true,
					systemPrompt: fullSystemPrompt,
				},
			})
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					customTools: tools,
				})),
				services,
				diagnostics: services.diagnostics,
			}
		}

		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd,
			agentDir: getAgentDir(),
			sessionManager: SessionManager.create(cwd),
		})
		const session = runtime.session

		// Normalize + forward pi events onto the library bus.
		const listener: AgentSessionEventListener = (event) => {
			const normalized = normalizePiEvent(who, session.sessionId, event)
			if (normalized) bus.emit(normalized)
		}
		session.subscribe(listener)

		emitSessionStarted(bus, who, session.sessionId)

		return {
			sessionId: session.sessionId,
			prompt: (text: string) => session.prompt(text),
			isStreaming: () => session.isStreaming,
			abort: () => session.abort(),
		}
	}
}

/** Return the role identity currently attached to the visible Pi session. */
export type VisibleRoleResolver = (
	ctx: ExtensionContext,
) => RoleIdentity | undefined | Promise<RoleIdentity | undefined>

export interface PiVisibleLeadSessionRunnerOptions
	extends PiSessionRunnerOptions {
	/** The extension API bound to the user's current visible Pi session. */
	pi: Pick<
		ExtensionAPI,
		| "on"
		| "sendUserMessage"
		| "registerTool"
		| "getActiveTools"
		| "setActiveTools"
	>
	/** The latest live extension context for the current visible session. */
	getContext(): ExtensionContext | undefined
	/** Maps the current visible session context to a Command Center role, if any. */
	resolveVisibleRole: VisibleRoleResolver
	/**
	 * Hidden-session fallback. Defaults to PiSessionRunner, preserving the
	 * headless path and keeping owners off the visible session.
	 */
	hiddenRunner?: SessionRunner
}

interface ActiveVisibleLead {
	who: RoleIdentity
	cwd: string
	sessionId: string
	systemPrompt: string
	tools: ToolDefinition[]
	toolNames: string[]
	bridgedToolEventKeys: Set<string>
}

interface VisibleWaiter {
	promise: Promise<void>
	resolve(): void
	reject(error: Error): void
}

interface VisibleSettledWait {
	promise: Promise<void>
	cancel(): void
}

const DOMAIN_TOOL_NAMES = new Set([
	"define_mission",
	"write_plan",
	"update_memory",
	"review_work_item",
	"respond_to_help",
	"request_human_input",
	"report_status",
])

/**
 * Hybrid runner for extension use: Mission Lead turns can run in the user's
 * current visible Pi session, while owners (and unattached lead requests) keep
 * using the SDK-backed hidden-session runner.
 */
export class PiVisibleLeadSessionRunner implements SessionRunner {
	private readonly hidden: SessionRunner
	private activeVisibleLead?: ActiveVisibleLead
	private readonly registeredToolNames = new Set<string>()
	private readonly waiters: VisibleWaiter[] = []

	constructor(private readonly opts: PiVisibleLeadSessionRunnerOptions) {
		this.hidden = opts.hiddenRunner ?? new PiSessionRunner(opts)
		this.installEventBridges()
	}

	async startOrResume(
		who: RoleIdentity,
		cwd: string,
		systemPrompt: string,
		tools: ToolDefinition[],
	): Promise<RoleSession> {
		if (who.roleName !== "mission_lead") {
			return this.hidden.startOrResume(who, cwd, systemPrompt, tools)
		}

		const ctx = this.opts.getContext()
		const attached = ctx ? await this.opts.resolveVisibleRole(ctx) : undefined
		if (!ctx || !sameRole(attached, who)) {
			// Inert visible adapter: no prompt injection, no extension tool
			// registration. The regular SDK path is still available.
			return this.hidden.startOrResume(who, cwd, systemPrompt, tools)
		}

		const fullSystemPrompt = await buildSystemPrompt(
			systemPrompt,
			this.opts.store,
		)(who)
		const domainTools = tools.filter((tool) => DOMAIN_TOOL_NAMES.has(tool.name))
		this.registerVisibleTools(domainTools)
		this.activateVisibleTools(domainTools.map((tool) => tool.name))

		const sessionId = ctx.sessionManager.getSessionId()
		this.activeVisibleLead = {
			who,
			cwd,
			sessionId,
			systemPrompt: fullSystemPrompt,
			tools: domainTools,
			toolNames: domainTools.map((tool) => tool.name),
			bridgedToolEventKeys: new Set(),
		}

		emitSessionStarted(this.opts.bus, who, sessionId)

		return new VisibleLeadRoleSession(
			who,
			sessionId,
			this.opts.pi,
			() => this.opts.getContext(),
			(ctx) => this.isActiveVisibleSession(who, sessionId, ctx),
			() => this.waitForVisibleSettled(),
		)
	}

	private installEventBridges(): void {
		const pi = this.opts.pi
		pi.on("session_start", async (_event, ctx) => {
			const active = this.activeVisibleLead
			if (!active) return
			const stillActive = await this.isActiveVisibleSession(
				active.who,
				active.sessionId,
				ctx,
			)
			if (!stillActive) {
				this.detachVisibleLead(
					"Visible Command Center lead session changed before the turn settled",
				)
			}
		})

		pi.on("session_before_switch", () => {
			this.detachVisibleLead(
				"Visible Command Center lead session switched before the turn settled",
			)
		})

		pi.on("session_shutdown", () => {
			this.detachVisibleLead(
				"Visible Command Center lead session shut down before the turn settled",
			)
		})

		pi.on("before_agent_start", async (_event, ctx) => {
			const active = await this.matchingActiveLead(ctx)
			if (!active) return undefined
			this.activateVisibleTools(active.toolNames)
			return { systemPrompt: active.systemPrompt }
		})

		const onRawSessionEvent = pi.on.bind(pi) as (
			event: string,
			handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>,
		) => void
		for (const eventName of [
			"message_update",
			"tool_execution_start",
			"tool_execution_end",
			"message_end",
			"agent_end",
		]) {
			onRawSessionEvent(eventName, async (event, ctx) => {
				const active = await this.matchingActiveLead(ctx)
				if (!active) return
				const raw = event as AgentSessionEvent
				if (this.seenVisibleToolEvent(active, raw)) return
				const normalized = normalizePiEvent(active.who, active.sessionId, raw)
				if (normalized) this.opts.bus.emit(normalized)
			})
		}

		pi.on("agent_settled", async (_event, ctx) => {
			const active = await this.matchingActiveLead(ctx)
			if (!active) return
			const waiters = this.waiters.splice(0)
			for (const waiter of waiters) waiter.resolve()
		})
	}

	private seenVisibleToolEvent(
		active: ActiveVisibleLead,
		event: AgentSessionEvent,
	): boolean {
		if (
			event.type !== "tool_execution_start" &&
			event.type !== "tool_execution_end"
		) {
			return false
		}
		const key = `${event.type}:${event.toolCallId}`
		if (active.bridgedToolEventKeys.has(key)) return true
		active.bridgedToolEventKeys.add(key)
		return false
	}

	private async matchingActiveLead(
		ctx: ExtensionContext,
	): Promise<ActiveVisibleLead | undefined> {
		const active = this.activeVisibleLead
		if (!active) return undefined
		const attached = await this.opts.resolveVisibleRole(ctx)
		if (!sameRole(attached, active.who)) return undefined
		if (ctx.sessionManager.getSessionId() !== active.sessionId) return undefined
		return active
	}

	private async isActiveVisibleSession(
		who: RoleIdentity,
		sessionId: string,
		ctx: ExtensionContext,
	): Promise<boolean> {
		const active = await this.matchingActiveLead(ctx)
		return active?.sessionId === sessionId && sameRole(active.who, who)
	}

	private registerVisibleTools(tools: ToolDefinition[]): void {
		for (const tool of tools) {
			if (this.registeredToolNames.has(tool.name)) continue
			this.opts.pi.registerTool(this.dynamicTool(tool.name, tool))
			this.registeredToolNames.add(tool.name)
		}
	}

	private dynamicTool(name: string, initial: ToolDefinition): ToolDefinition {
		return {
			...initial,
			execute: async (toolCallId, params, signal, onUpdate, ctx) => {
				const active = await this.matchingActiveLead(ctx)
				const tool = active?.tools.find((t) => t.name === name)
				if (!tool) {
					return {
						content: [
							{
								type: "text",
								text: `Command Center tool ${name} is not active in this visible session.`,
							},
						],
						isError: true,
					}
				}
				return tool.execute(toolCallId, params, signal, onUpdate, ctx)
			},
		} as ToolDefinition
	}

	private activateVisibleTools(names: string[]): void {
		const active = this.opts.pi.getActiveTools()
		const next = [...active]
		for (const name of names) {
			if (!next.includes(name)) next.push(name)
		}
		if (next.length !== active.length) this.opts.pi.setActiveTools(next)
	}

	private deactivateVisibleTools(): void {
		if (this.registeredToolNames.size === 0) return
		const active = this.opts.pi.getActiveTools()
		const next = active.filter((name) => !this.registeredToolNames.has(name))
		if (next.length !== active.length) this.opts.pi.setActiveTools(next)
	}

	private detachVisibleLead(reason: string): void {
		this.deactivateVisibleTools()
		this.activeVisibleLead = undefined
		const error = new Error(reason)
		const waiters = this.waiters.splice(0)
		for (const waiter of waiters) waiter.reject(error)
	}

	private waitForVisibleSettled(): VisibleSettledWait {
		let resolveWaiter!: () => void
		let rejectWaiter!: (error: Error) => void
		const promise = new Promise<void>((resolve, reject) => {
			resolveWaiter = resolve
			rejectWaiter = (error) => reject(error)
		})
		const waiter: VisibleWaiter = {
			promise,
			resolve: resolveWaiter,
			reject: rejectWaiter,
		}
		this.waiters.push(waiter)
		return {
			promise,
			cancel: () => {
				const index = this.waiters.indexOf(waiter)
				if (index >= 0) this.waiters.splice(index, 1)
			},
		}
	}
}

class VisibleLeadRoleSession implements RoleSession {
	constructor(
		private readonly who: RoleIdentity,
		public readonly sessionId: string,
		private readonly pi: Pick<ExtensionAPI, "sendUserMessage">,
		private readonly getContext: () => ExtensionContext | undefined,
		private readonly isActiveVisibleSession: (
			ctx: ExtensionContext,
		) => Promise<boolean>,
		private readonly waitForSettled: () => VisibleSettledWait,
	) {}

	async prompt(text: string): Promise<void> {
		const ctx = this.getContext()
		if (!ctx || !(await this.isActiveVisibleSession(ctx))) {
			throw new Error(
				`Visible session is no longer attached to Mission ${this.who.missionId}'s acquired lead session`,
			)
		}
		const settled = this.waitForSettled()
		try {
			this.pi.sendUserMessage(
				text,
				ctx.isIdle() ? undefined : { deliverAs: "followUp" },
			)
		} catch (error) {
			settled.cancel()
			throw error
		}
		await settled.promise
	}

	isStreaming(): boolean {
		return !(this.getContext()?.isIdle() ?? true)
	}

	abort(): void {
		this.getContext()?.abort()
	}
}

function emitSessionStarted(
	bus: EventBus,
	who: RoleIdentity,
	sessionId: string,
): void {
	bus.emit({
		type: "session-started",
		missionId: who.missionId,
		roleName: who.roleName,
		...(who.workItemId !== undefined ? { workItemId: who.workItemId } : {}),
		sessionId,
	})
}

function sameRole(
	a: RoleIdentity | undefined,
	b: RoleIdentity | undefined,
): boolean {
	if (!a || !b) return false
	return (
		a.missionId === b.missionId &&
		a.roleName === b.roleName &&
		a.workItemId === b.workItemId
	)
}

// ---------------------------------------------------------------------------
// FakeSessionRunner — for Orchestrator tests (no model calls).
//
// Records prompts and exposes a hook to push events onto the bus, so a test
// can simulate an owner calling request_review, a lead calling review_work_item,
// deltas, etc. — deterministically.
// ---------------------------------------------------------------------------

export interface FakeSessionHooks {
	/** Called with each prompt; may return/simulate by pushing events. */
	onPrompt?: (session: FakeRoleSession, text: string) => void | Promise<void>
}

export class FakeRoleSession implements RoleSession {
	constructor(
		public readonly sessionId: string,
		public readonly who: RoleIdentity,
		private readonly bus: EventBus,
		private readonly hooks: FakeSessionHooks,
		public readonly prompts: string[] = [],
	) {}

	async prompt(text: string): Promise<void> {
		this.prompts.push(text)
		await this.hooks.onPrompt?.(this, text)
	}

	abort(): void {
		// no-op for fake
	}

	isStreaming(): boolean {
		return false
	}

	/** Test helper: push a normalized event onto the bus as this session. */
	emit(e: EmittableEvent): void {
		this.bus.emit(e)
	}
}

export class FakeSessionRunner implements SessionRunner {
	public sessions = new Map<string, FakeRoleSession>()
	private counter = 0

	constructor(
		private readonly bus: EventBus,
		private readonly hooks: FakeSessionHooks = {},
	) {}

	async startOrResume(
		who: RoleIdentity,
		_cwd: string,
		_systemPrompt: string,
		_tools: ToolDefinition[],
	): Promise<RoleSession> {
		const key = roleKey(who)
		const existing = this.sessions.get(key)
		if (existing) return existing
		const sessionId = `fake-${this.counter++}`
		const session = new FakeRoleSession(sessionId, who, this.bus, this.hooks)
		this.sessions.set(key, session)
		this.bus.emit({
			type: "session-started",
			missionId: who.missionId,
			roleName: who.roleName,
			...(who.workItemId !== undefined ? { workItemId: who.workItemId } : {}),
			sessionId,
		})
		return session
	}
}

function roleKey(who: RoleIdentity): string {
	return `${who.missionId}:${who.roleName}:${who.workItemId ?? "_"}`
}
