import { exec } from "node:child_process"
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import { ensureServerRunning, PORT } from "./server"

export function openBrowser(url: string): Promise<void> {
	return new Promise((resolve) => {
		let command: string
		if (process.platform === "darwin") {
			command = `open "${url}"`
		} else if (process.platform === "win32") {
			command = `start "" "${url}"`
		} else {
			command = `xdg-open "${url}"`
		}
		const child = exec(command, (err) => {
			if (err) {
				console.error(`Failed to open browser: ${err.message}`)
			}
		})
		child.unref()
		resolve()
	})
}

export interface PiCommandDefinition {
	name: string
	description: string
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>
}

export const tweetsUiCommand: PiCommandDefinition = {
	name: "tweets-ui",
	description:
		"Start the Tweets Express server on port 3000 and open the UI in browser",
	handler: async (_args: string, ctx: ExtensionCommandContext) => {
		await ensureServerRunning(PORT)
		const url = `http://localhost:${PORT}`
		await openBrowser(url)
		ctx?.ui?.notify?.(`Tweets UI opened at ${url}`, "info")
	},
}
