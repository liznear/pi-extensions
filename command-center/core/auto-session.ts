import type {
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent"
import type { EventBus } from "./events"
import { HerdrSessionRunner, isHerdrEnv } from "./herdr-session"
import { isOrcaEnv, OrcaSessionRunner } from "./orca-session"

export { isHerdrEnv } from "./herdr-session"
export { isOrcaEnv } from "./orca-session"

import {
	PiSessionRunner,
	PiVisibleLeadSessionRunner,
	type RoleSession,
	type SessionRunner,
} from "./session"
import type { Store } from "./store"
import type { RoleIdentity } from "./types"

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
	orcaRunner?: SessionRunner
	isOrcaEnv?: () => boolean
}

export class AutoSessionRunner implements SessionRunner {
	private readonly fallbackRunner: SessionRunner
	private readonly herdrRunner: SessionRunner
	private readonly isHerdrEnvFn: () => boolean
	private readonly orcaRunner: SessionRunner
	private readonly isOrcaEnvFn: () => boolean

	constructor(opts: AutoSessionRunnerOptions) {
		this.isHerdrEnvFn = opts.isHerdrEnv ?? isHerdrEnv
		this.isOrcaEnvFn = opts.isOrcaEnv ?? isOrcaEnv

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

		this.orcaRunner =
			opts.orcaRunner ??
			new OrcaSessionRunner({ bus: opts.bus, store: opts.store })
	}

	async startOrResume(
		who: RoleIdentity,
		cwd: string,
		systemPrompt: string,
		tools: ToolDefinition[],
	): Promise<RoleSession> {
		const isHerdr = this.isHerdrEnvFn()
		const isOrca = this.isOrcaEnvFn()

		// Herdr pane runner or Orca terminal runner is used specifically for work_item_owner sessions
		if (who.roleName === "work_item_owner") {
			if (isHerdr) {
				return this.herdrRunner.startOrResume(who, cwd, systemPrompt, tools)
			}
			if (isOrca) {
				return this.orcaRunner.startOrResume(who, cwd, systemPrompt, tools)
			}
		}

		return this.fallbackRunner.startOrResume(who, cwd, systemPrompt, tools)
	}
}

export function createAutoSessionRunner(
	opts: AutoSessionRunnerOptions,
): SessionRunner {
	return new AutoSessionRunner(opts)
}
