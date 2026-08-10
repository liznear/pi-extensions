import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent"
import tweetsExtension, {
	isServerRunning,
	stopServer,
	tweetsUiCommand,
} from "../index"

describe("tweets UI command", () => {
	beforeEach(async () => {
		await stopServer()
	})

	afterEach(async () => {
		await stopServer()
	})

	test("tweetsUiCommand exports a valid Pi command object schema", () => {
		expect(tweetsUiCommand).toBeDefined()
		expect(tweetsUiCommand.name).toBe("tweets-ui")
		expect(typeof tweetsUiCommand.description).toBe("string")
		expect(tweetsUiCommand.description.length).toBeGreaterThan(0)
		expect(typeof tweetsUiCommand.handler).toBe("function")
	})

	test("tweetsExtension registers tools and the tweets-ui command", () => {
		const registeredTools: unknown[] = []
		const registeredCommands: Array<{ name: string; options: unknown }> = []

		const mockPi = {
			registerTool: (tool: unknown) => {
				registeredTools.push(tool)
			},
			registerCommand: (name: string, options: unknown) => {
				registeredCommands.push({ name, options })
			},
		} as unknown as ExtensionAPI

		tweetsExtension(mockPi)

		expect(registeredTools.length).toBe(3)
		expect(registeredCommands.length).toBe(1)
		expect(registeredCommands[0].name).toBe("tweets-ui")
		const cmdOpts = registeredCommands[0].options as { description: string }
		expect(cmdOpts.description).toBe(tweetsUiCommand.description)
	})

	test("executing tweetsUiCommand handler starts the server on port 3000 and notifies user", async () => {
		let notifiedMessage = ""
		const mockCtx = {
			ui: {
				notify: (msg: string) => {
					notifiedMessage = msg
				},
			},
		} as unknown as ExtensionCommandContext

		// Execute handler
		await tweetsUiCommand.handler("", mockCtx)

		// Verify server is now running on port 3000
		expect(await isServerRunning(3000)).toBe(true)
		expect(notifiedMessage).toContain(
			"Tweets UI opened at http://localhost:3000",
		)

		// Verify API endpoint returns 200 OK
		const res = await fetch("http://localhost:3000/api/tweets")
		expect(res.status).toBe(200)
		const data = await res.json()
		expect(Array.isArray(data)).toBe(true)
	})
})
