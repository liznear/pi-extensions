import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import * as fs from "fs"
import * as path from "path"

export default function (pi: ExtensionAPI) {
	const getContextDir = (workspacePath: string) =>
		path.join(workspacePath, ".context")

	pi.on("session_start", async (_event, ctx) => {
		// Ensure the .context directory exists
		const contextDir = getContextDir(ctx.cwd)
		if (!fs.existsSync(contextDir)) {
			fs.mkdirSync(contextDir, { recursive: true })
			fs.mkdirSync(path.join(contextDir, "terms"), { recursive: true })
			fs.mkdirSync(path.join(contextDir, "routing"), { recursive: true })
			fs.mkdirSync(path.join(contextDir, "decisions"), { recursive: true })
			fs.mkdirSync(path.join(contextDir, "conventions"), { recursive: true })
			fs.writeFileSync(
				path.join(contextDir, "README.md"),
				"# Context Layer Index\nThis directory contains machine-readable business context, architectural decisions, and routing logic for AI agents.",
			)
		}
		// Remind the user if we just created it or it's empty
		ctx.ui.notify("Context Layer Active", "info")
	})

	pi.registerTool({
		name: "query_context",
		label: "Query Context Layer",
		description:
			"REQUIRED FIRST STEP for any task involving business logic, jargon, or architecture. Query the progressive context layer (.context) for definitions and routing rules. Use this BEFORE you try to search the codebase with grep or symbol_search.",
		promptSnippet:
			"Use query_context FIRST to find business rules, jargon definitions, or architecture boundaries.",
		parameters: {
			type: "object",
			properties: {
				topic: {
					type: "string",
					description: "The term or concept to search for",
				},
			},
			required: ["topic"],
		},
		execute: async (_toolCallId, args: any, _signal, _onUpdate, ctx) => {
			const contextDir = getContextDir(ctx.cwd)
			// For a simple implementation, we just do a grep-like scan or file check
			if (!fs.existsSync(contextDir)) {
				return {
					content: [
						{ type: "text", text: "NOT_FOUND. The context layer is empty." },
					],
					details: {},
				}
			}

			// Let's do a basic recursive search
			const findFiles = (dir: string, fileList: string[] = []) => {
				const files = fs.readdirSync(dir)
				for (const file of files) {
					const filePath = path.join(dir, file)
					if (fs.statSync(filePath).isDirectory()) {
						findFiles(filePath, fileList)
					} else if (filePath.endsWith(".md")) {
						fileList.push(filePath)
					}
				}
				return fileList
			}

			const files = findFiles(contextDir)
			const results = []
			const lowerTopic = args.topic.toLowerCase()

			for (const file of files) {
				const content = fs.readFileSync(file, "utf-8")
				if (
					file.toLowerCase().includes(lowerTopic) ||
					content.toLowerCase().includes(lowerTopic)
				) {
					results.push(
						`--- File: ${path.relative(ctx.cwd, file)} ---\n${content}\n`,
					)
				}
			}

			if (results.length > 0) {
				return {
					content: [{ type: "text", text: results.join("\n") }],
					details: {},
				}
			} else {
				return {
					content: [
						{
							type: "text",
							text: `NOT_FOUND. No context found for '${args.topic}'. Use ask_for_context to request it.`,
						},
					],
					details: {},
				}
			}
		},
	})

	pi.registerTool({
		name: "ask_for_context",
		label: "Ask for Context",
		description:
			"REQUIRED when you do not understand a business concept or routing rule. Use this INSTEAD OF ask_user when you need project context. DO NOT GUESS.",
		promptSnippet:
			"Use ask_for_context to demand human clarification on missing business logic or jargon.",
		parameters: {
			type: "object",
			properties: {
				missing_concept: {
					type: "string",
					description: "The specific term, rule, or concept you need",
				},
				reason: {
					type: "string",
					description: "Why you need this to proceed safely",
				},
			},
			required: ["missing_concept", "reason"],
		},
		execute: async (_toolCallId, args: any, _signal, _onUpdate, ctx) => {
			const prompt = `Agent is blocked and needs context.\nMissing Concept: ${args.missing_concept}\nReason: ${args.reason}\n\nPlease provide the context or point to the correct file:`
			const answer = await ctx.ui.input(prompt)
			if (!answer) {
				return {
					content: [
						{
							type: "text",
							text: "Human cancelled the request. You may need to abort the task or ask again differently.",
						},
					],
					details: {},
				}
			}
			return {
				content: [
					{
						type: "text",
						text: `Human provided context: ${answer}\n\nIMPORTANT: You MUST now use persist_context to save this learning before proceeding.`,
					},
				],
				details: {},
			}
		},
	})

	pi.registerTool({
		name: "persist_context",
		label: "Persist Context",
		description:
			"REQUIRED immediately after ask_for_context succeeds. Save newly learned context into the .context directory so future agents don't have to ask.",
		promptSnippet:
			"Use persist_context to save answers learned from the human into the codebase permanently.",
		parameters: {
			type: "object",
			properties: {
				category: {
					type: "string",
					enum: ["terms", "routing", "decisions", "conventions"],
					description: "The subfolder to save this context in",
				},
				title: {
					type: "string",
					description:
						"A short, file-safe slug for the concept (e.g. 'drive-thru-time')",
				},
				content: {
					type: "string",
					description: "The detailed explanation, written in Markdown",
				},
			},
			required: ["category", "title", "content"],
		},
		execute: async (_toolCallId, args: any, _signal, _onUpdate, ctx) => {
			const contextDir = getContextDir(ctx.cwd)
			const targetDir = path.join(contextDir, args.category)
			if (!fs.existsSync(targetDir)) {
				fs.mkdirSync(targetDir, { recursive: true })
			}

			const safeTitle = args.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")
			const targetFile = path.join(targetDir, `${safeTitle}.md`)

			fs.writeFileSync(targetFile, args.content)

			return {
				content: [
					{
						type: "text",
						text: `Success. Context saved to ${path.relative(ctx.cwd, targetFile)}.`,
					},
				],
				details: {},
			}
		},
	})
}
