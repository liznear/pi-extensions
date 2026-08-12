import { describe, expect, test } from "bun:test"
import { AutoSessionRunner } from "../auto-session"
import { EventBus } from "../events"
import {
	type HerdrCli,
	type HerdrPaneInfo,
	HerdrRoleSession,
	HerdrSessionRunner,
	isHerdrEnv,
} from "../herdr-session"
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

class MockHerdrCli implements HerdrCli {
	isHerdr = true
	panes: HerdrPaneInfo[] = []
	splitPaneCalls: Array<{ cwd: string; direction?: string }> = []
	runInPaneCalls: Array<{ paneId: string; command: string }> = []
	sendTextCalls: Array<{ paneId: string; text: string }> = []

	isHerdrEnv(): boolean {
		return this.isHerdr
	}

	async splitPane(opts: {
		cwd: string
		direction?: "right" | "down"
	}): Promise<string> {
		this.splitPaneCalls.push(opts)
		const newPaneId = `p${this.panes.length + 1}`
		const newPane: HerdrPaneInfo = { pane_id: newPaneId, cwd: opts.cwd }
		this.panes.push(newPane)
		return newPaneId
	}

	async listPanes(): Promise<HerdrPaneInfo[]> {
		return this.panes
	}

	async runInPane(paneId: string, command: string): Promise<void> {
		this.runInPaneCalls.push({ paneId, command })
	}

	async sendText(paneId: string, text: string): Promise<void> {
		this.sendTextCalls.push({ paneId, text })
	}

	async closePane(paneId: string): Promise<void> {
		this.panes = this.panes.filter((p) => p.pane_id !== paneId)
	}
}

describe("isHerdrEnv", () => {
	test("returns true when HERDR_ENV is 1", () => {
		const orig = process.env.HERDR_ENV
		try {
			delete process.env.HERDR_ENV
			expect(isHerdrEnv()).toBe(false)
			process.env.HERDR_ENV = "1"
			expect(isHerdrEnv()).toBe(true)
		} finally {
			if (orig !== undefined) process.env.HERDR_ENV = orig
			else delete process.env.HERDR_ENV
		}
	})
})

describe("AutoSessionRunner", () => {
	test("dispatches lead role to fallback runner even in Herdr environment", async () => {
		const fallback = new MockSessionRunner()
		const herdr = new MockSessionRunner()
		const runner = new AutoSessionRunner({
			bus: new EventBus(),
			store: new InMemoryStore(),
			fallbackRunner: fallback,
			herdrRunner: herdr,
			isHerdrEnv: () => true,
			isOrcaEnv: () => false,
		})

		await runner.startOrResume(leadRole, "/tmp", "sys", [])

		expect(fallback.calledWith).toHaveLength(1)
		expect(herdr.calledWith).toHaveLength(0)
	})

	test("dispatches owner role to fallback runner when not in Herdr environment", async () => {
		const fallback = new MockSessionRunner()
		const herdr = new MockSessionRunner()
		const runner = new AutoSessionRunner({
			bus: new EventBus(),
			store: new InMemoryStore(),
			fallbackRunner: fallback,
			herdrRunner: herdr,
			isHerdrEnv: () => false,
			isOrcaEnv: () => false,
		})

		await runner.startOrResume(ownerRole, "/tmp", "sys", [])

		expect(fallback.calledWith).toHaveLength(1)
		expect(herdr.calledWith).toHaveLength(0)
	})

	test("dispatches owner role to herdr runner when in Herdr environment", async () => {
		const fallback = new MockSessionRunner()
		const herdr = new MockSessionRunner()
		const runner = new AutoSessionRunner({
			bus: new EventBus(),
			store: new InMemoryStore(),
			fallbackRunner: fallback,
			herdrRunner: herdr,
			isHerdrEnv: () => true,
			isOrcaEnv: () => false,
		})

		await runner.startOrResume(ownerRole, "/tmp", "sys", [])

		expect(fallback.calledWith).toHaveLength(0)
		expect(herdr.calledWith).toHaveLength(1)
	})
})

describe("HerdrSessionRunner", () => {
	test("splits a new pane when no active pane exists", async () => {
		const bus = new EventBus()
		const store = new InMemoryStore()
		const cli = new MockHerdrCli()

		const runner = new HerdrSessionRunner({ bus, store, herdrCli: cli })
		const session = await runner.startOrResume(
			ownerRole,
			"/tmp/work-1",
			"sys",
			[],
		)

		expect(cli.splitPaneCalls).toHaveLength(1)
		expect(cli.splitPaneCalls[0]!.cwd).toBe("/tmp/work-1")
		expect(session.sessionId).toBe("herdr:p1")
	})

	test("reuses existing pane if still alive in herdr listPanes", async () => {
		const bus = new EventBus()
		const store = new InMemoryStore()
		const cli = new MockHerdrCli()

		const runner = new HerdrSessionRunner({ bus, store, herdrCli: cli })
		const s1 = await runner.startOrResume(ownerRole, "/tmp/work-1", "sys", [])
		const s2 = await runner.startOrResume(ownerRole, "/tmp/work-1", "sys", [])

		expect(cli.splitPaneCalls).toHaveLength(1)
		expect(s1.sessionId).toBe("herdr:p1")
		expect(s2.sessionId).toBe("herdr:p1")
	})
})

describe("HerdrRoleSession", () => {
	test("completes prompt turn when store plan work item status leaves in_progress", async () => {
		const bus = new EventBus()
		const store = new InMemoryStore()
		const cli = new MockHerdrCli()
		cli.panes.push({ pane_id: "p1", cwd: "/tmp" })

		// Set initial plan with in_progress item
		await store.writePlan("m1", {
			items: [
				{
					id: 1,
					title: "test",
					description: "test item",
					status: "in_progress",
					dependencies: [],
				},
			],
		})

		const session = new HerdrRoleSession({
			who: ownerRole,
			cwd: "/tmp",
			paneId: "p1",
			store,
			bus,
			herdrCli: cli,
			pollIntervalMs: 10,
		})

		// Transition status after 30ms
		setTimeout(async () => {
			await store.writeWorkItemStatus("m1", 1, "ready_for_review")
		}, 30)

		await session.prompt("Do task")

		expect(cli.runInPaneCalls).toHaveLength(1)
		expect(cli.runInPaneCalls[0]!.command).toContain('pi "Do task"')
		expect(session.isStreaming()).toBe(false)
	})
})
