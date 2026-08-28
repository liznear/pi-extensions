import { describe, expect, it } from "bun:test"
import type {
	AgentToolResult,
	ExtensionAPI,
} from "@earendil-works/pi-coding-agent"
import commandRunExtension from "../index.ts"

interface CommandRunArgs {
	commands: Array<{
		command_type: string
		parameters: Record<string, unknown>
	}>
}

interface CommandRunTool {
	execute: (
		toolCallId: string,
		args: CommandRunArgs,
		signal: undefined,
		onUpdate: undefined,
		context: { cwd: string },
	) => Promise<AgentToolResult<unknown>>
	renderResult: (
		result: AgentToolResult<unknown>,
		options: { expanded: boolean; isPartial: boolean },
		theme: typeof plainTheme,
		context: { args: CommandRunArgs; lastComponent: undefined },
	) => { render: (width: number) => string[] }
}

function registerCommandRunTool(): CommandRunTool {
	let tool: unknown
	commandRunExtension({
		registerTool(definition: unknown) {
			tool = definition
		},
	} as unknown as ExtensionAPI)
	return tool as CommandRunTool
}

const plainTheme = {
	bold: (text: string) => text,
	fg: (_color: string, text: string) => text,
}

describe("command_run rendering", () => {
	it("shows the complete command and output when expanded", async () => {
		const tool = registerCommandRunTool()
		const command = `printf '%s\\n' '${"command-".repeat(12)}'`
		const expectedOutput = "output-".repeat(700)
		const outputCommand =
			"i=0; while [ \"$i\" -lt 700 ]; do printf 'output-'; i=$((i + 1)); done"
		const args = {
			commands: [
				{
					command_type: "bash",
					parameters: {
						command: `${command}; ${outputCommand}`,
					},
				},
			],
		}

		const result = await tool.execute("test-call", args, undefined, undefined, {
			cwd: process.cwd(),
		})
		const component = tool.renderResult(
			result,
			{ expanded: true, isPartial: false },
			plainTheme,
			{ args, lastComponent: undefined },
		)
		const rendered = component.render(20_000).join("\n")

		expect(rendered).toContain(args.commands[0].parameters.command)
		expect(rendered).toContain(expectedOutput)
	})
})
