import { describe, expect, test } from "bun:test"
import { AutoSessionRunner } from "../auto-session"
import { EventBus } from "../events"
import {
	isOrcaEnv,
	type OrcaCli,
	OrcaRoleSession,
	OrcaSessionRunner,
	type OrcaTerminalInfo,
	resolveOrcaCliCommand,
} from "../orca-session"
import type { RoleSession, SessionRunner } from "../session"
import { InMemoryStore } from "../store"
import type { RoleIdentity } from "../types"

const leadRole: RoleIdentity = { missionId: "m1", roleName: "mission_lead" }
const ownerRole: RoleIdentity = {
	missionId: "m1",
	roleName: "work_item_owner",
	workItemId: 1,
}

class MockRoleSession implements RoleSession {
	sessionId = "mock-session"
	streaming = false

	async prompt(): Promise<void> {}
	isStreaming(): boolean {
		return this.streaming
	}
	abort(): void {}
}

class MockSessionRunner implements SessionRunner {
	calledWith: RoleIdentity[] = []

	async startOrResume(who: RoleIdentity): Promise<RoleSession> {
		this.calledWith.push(who)
		return new MockRoleSession()
	}
}

class MockOrcaCli implements OrcaCli {
	isOrca = true
	terminals: OrcaTerminalInfo[] = []
	createTerminalCalls: Array<{
		cwd: string
		title?: string
		command?: string
	}> = []
	splitTerminalCalls: Array<{
		terminalHandle?: string
		direction?: "horizontal" | "vertical"
		command?: string
	}> = []
	sendTextCalls: Array<{
		terminalHandle: string
		text: string
		enter?: boolean
	}> = []

	isOrcaEnv(): boolean {
		return this.isOrca
	}

	async createTerminal(opts: {
		cwd: string
		title?: string
		command?: string
	}): Promise<string> {
		this.createTerminalCalls.push(opts)
		const handle = `term_${this.terminals.length + 1}`
		const info: OrcaTerminalInfo = {
			handle,
			worktreePath: opts.cwd,
			title: opts.title,
		}
		this.terminals.push(info)
		return handle
	}

	async splitTerminal(opts: {
		terminalHandle?: string
		direction?: "horizontal" | "vertical"
		command?: string
	}): Promise<string> {
		this.splitTerminalCalls.push(opts)
		const handle = `term_${this.terminals.length + 1}`
		const info: OrcaTerminalInfo = { handle }
		this.terminals.push(info)
		return handle
	}

	async listTerminals(): Promise<OrcaTerminalInfo[]> {
		return this.terminals
	}

	async sendText(
		terminalHandle: string,
		text: string,
		enter = true,
	): Promise<void> {
		this.sendTextCalls.push({ terminalHandle, text, enter })
	}

	async closeTerminal(terminalHandle: string): Promise<void> {
		this.terminals = this.terminals.filter((t) => t.handle !== terminalHandle)
	}
}

describe("Orca Environment & CLI Resolution Helpers", () => {
	test("resolveOrcaCliCommand respects environment variables and platform", () => {
		const origCliCmd = process.env.ORCA_CLI_COMMAND
		const origDevRoot = process.env.ORCA_DEV_REPO_ROOT
		try {
			delete process.env.ORCA_CLI_COMMAND
			delete process.env.ORCA_DEV_REPO_ROOT

			expect(resolveOrcaCliCommand()).toBe("orca")

			process.env.ORCA_CLI_COMMAND = "custom-orca"
			expect(resolveOrcaCliCommand()).toBe("custom-orca")

			delete process.env.ORCA_CLI_COMMAND
			process.env.ORCA_DEV_REPO_ROOT = "/dev/root"
			expect(resolveOrcaCliCommand()).toBe("orca-dev")
		} finally {
			if (origCliCmd !== undefined) process.env.ORCA_CLI_COMMAND = origCliCmd
			else delete process.env.ORCA_CLI_COMMAND
			if (origDevRoot !== undefined)
				process.env.ORCA_DEV_REPO_ROOT = origDevRoot
			else delete process.env.ORCA_DEV_REPO_ROOT
		}
	})

	test("isOrcaEnv detects presence of Orca env vars", () => {
		const origWorktree = process.env.ORCA_WORKTREE_ID
		const origEnv = process.env.ORCA_ENV
		try {
			delete process.env.ORCA_WORKTREE_ID
			delete process.env.ORCA_TERMINAL_HANDLE
			delete process.env.ORCA_WORKSPACE_ID
			delete process.env.ORCA_ENV

			expect(isOrcaEnv()).toBe(false)

			process.env.ORCA_ENV = "1"
			expect(isOrcaEnv()).toBe(true)
		} finally {
			if (origWorktree !== undefined)
				process.env.ORCA_WORKTREE_ID = origWorktree
			else delete process.env.ORCA_WORKTREE_ID
			if (origEnv !== undefined) process.env.ORCA_ENV = origEnv
			else delete process.env.ORCA_ENV
		}
	})
})

describe("AutoSessionRunner with Orca", () => {
	test("dispatches owner role to orca runner when in Orca environment", async () => {
		const fallback = new MockSessionRunner()
		const herdr = new MockSessionRunner()
		const orca = new MockSessionRunner()
		const runner = new AutoSessionRunner({
			bus: new EventBus(),
			store: new InMemoryStore(),
			fallbackRunner: fallback,
			herdrRunner: herdr,
			orcaRunner: orca,
			isHerdrEnv: () => false,
			isOrcaEnv: () => true,
		})

		await runner.startOrResume(ownerRole, "/tmp", "sys", [])

		expect(fallback.calledWith).toHaveLength(0)
		expect(herdr.calledWith).toHaveLength(0)
		expect(orca.calledWith).toHaveLength(1)
	})

	test("dispatches lead role to fallback runner even in Orca environment", async () => {
		const fallback = new MockSessionRunner()
		const orca = new MockSessionRunner()
		const runner = new AutoSessionRunner({
			bus: new EventBus(),
			store: new InMemoryStore(),
			fallbackRunner: fallback,
			orcaRunner: orca,
			isHerdrEnv: () => false,
			isOrcaEnv: () => true,
		})

		await runner.startOrResume(leadRole, "/tmp", "sys", [])

		expect(fallback.calledWith).toHaveLength(1)
		expect(orca.calledWith).toHaveLength(0)
	})
})

describe("OrcaSessionRunner", () => {
	test("creates a new terminal when no active terminal exists", async () => {
		const bus = new EventBus()
		const store = new InMemoryStore()
		const cli = new MockOrcaCli()

		const runner = new OrcaSessionRunner({ bus, store, orcaCli: cli })
		const session = await runner.startOrResume(
			ownerRole,
			"/tmp/work-1",
			"sys",
			[],
		)

		expect(cli.createTerminalCalls).toHaveLength(1)
		expect(cli.createTerminalCalls[0]!.cwd).toBe("/tmp/work-1")
		expect(session.sessionId).toBe("orca:term_1")
	})

	test("reuses existing terminal if still alive in listTerminals", async () => {
		const bus = new EventBus()
		const store = new InMemoryStore()
		const cli = new MockOrcaCli()

		const runner = new OrcaSessionRunner({ bus, store, orcaCli: cli })
		const s1 = await runner.startOrResume(ownerRole, "/tmp/work-1", "sys", [])
		const s2 = await runner.startOrResume(ownerRole, "/tmp/work-1", "sys", [])

		expect(cli.createTerminalCalls).toHaveLength(1)
		expect(s1.sessionId).toBe("orca:term_1")
		expect(s2.sessionId).toBe("orca:term_1")
	})
})

describe("OrcaRoleSession", () => {
	test("sends pi command on first prompt and terminates polling on status change", async () => {
		const bus = new EventBus()
		const store = new InMemoryStore()
		const cli = new MockOrcaCli()

		await store.writePlan("m1", {
			items: [
				{
					id: 1,
					title: "Item 1",
					description: "test item",
					status: "in_progress",
					dependencies: [],
				},
			],
		})

		const session = new OrcaRoleSession({
			who: ownerRole,
			cwd: "/tmp",
			terminalHandle: "term_1",
			store,
			bus,
			orcaCli: cli,
			pollIntervalMs: 10,
		})

		setTimeout(async () => {
			await store.writeWorkItemStatus("m1", 1, "ready_for_review")
		}, 30)

		await session.prompt("Do task")

		expect(cli.sendTextCalls).toHaveLength(1)
		expect(cli.sendTextCalls[0]!.text).toContain('pi "Do task"')
		expect(session.isStreaming()).toBe(false)
	})
})
