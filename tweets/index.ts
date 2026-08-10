import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { tweetsUiCommand } from "./command"
import { tweetTools } from "./tools"

export * from "./command"
export * from "./db"
export * from "./server"
export * from "./tools"

/**
 * Pi extension entrypoint registering tweet tools and commands.
 */
export default function tweetsExtension(pi: ExtensionAPI): void {
	for (const tool of tweetTools) {
		pi.registerTool(tool)
	}
	pi.registerCommand(tweetsUiCommand.name, {
		description: tweetsUiCommand.description,
		handler: tweetsUiCommand.handler,
	})
}
