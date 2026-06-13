/**
 * Explain Extension - Create rich HTML explanation pages
 *
 * Provides a `/explain` command and a `create_html_page` tool.
 * When you want to explain something, use `/explain <topic>` and the LLM
 * will create a beautifully styled, self-contained HTML page with diagrams,
 * interactive elements, and clear visual hierarchy, then open it in your browser.
 *
 * The create_html_page tool is kept hidden from the system prompt by default.
 * It is only activated temporarily during /explain turns via setActiveTools().
 */

import { execSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { platform, tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { Type } from "@sinclair/typebox"

const TOOL_NAME = "create_html_page"

function openInBrowser(filePath: string): void {
	const cmd =
		platform() === "darwin"
			? `open "${filePath}"`
			: platform() === "win32"
				? `start "" "${filePath}"`
				: `xdg-open "${filePath}"`
	execSync(cmd, { timeout: 5000 })
}

export default function (pi: ExtensionAPI) {
	// Temp directory for generated pages (OS temp cleaner handles old dirs)
	const EXPLAIN_DIR = mkdtempSync(join(tmpdir(), "pi-explain-"))

	// ============================================================
	// Tool: create_html_page (private — only activated during /explain)
	// ============================================================
	pi.registerTool({
		name: TOOL_NAME,
		label: "Create HTML Page",
		description:
			"Save HTML content to a file and open it in the browser. Use this to create rich, self-contained HTML pages with embedded CSS and JS — including SVG diagrams, interactive elements (expandable sections, tabs, code highlighting), color-coded structure, tables, and whatever visual aids make the content clear and engaging.",
		promptSnippet:
			"Create rich, self-contained HTML explanation pages with beautiful styling, SVG diagrams, and interactive elements.",
		promptGuidelines: [
			"Use create_html_page when the user asks to explain something in HTML — create a self-contained HTML page with embedded CSS/JS, save it, and open it in their browser.",
			"Make HTML explanations visually rich: use SVG for diagrams, color coding, visual hierarchy, and interactive elements where helpful.",
		],
		parameters: Type.Object({
			htmlContent: Type.String({
				description:
					"Full self-contained HTML content of the page (must include <!DOCTYPE html> with embedded CSS and JS, no external dependencies)",
			}),
			title: Type.Optional(
				Type.String({
					description: "Title for the page, used as filename hint",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const slug = params.title
				? params.title
						.toLowerCase()
						.replace(/[^a-z0-9]+/g, "-")
						.replace(/^-+|-+$/g, "")
						.slice(0, 60) || `page-${Date.now()}`
				: `explanation-${Date.now()}`
			const filePath = join(EXPLAIN_DIR, `${slug}.html`)

			writeFileSync(filePath, params.htmlContent, "utf-8")
			openInBrowser(filePath)

			ctx.ui.notify(`Opened: ${slug}.html`, "info")

			return {
				content: [
					{
						type: "text",
						text: `HTML page saved to ${filePath} and opened in your browser.`,
					},
				],
				details: { filePath, slug },
			}
		},
	})

	// Hide the tool from the default active set on session start.
	// (Can't call setActiveTools during factory — runtime not initialized yet.)
	pi.on("session_start", () => {
		const active: string[] = pi.getActiveTools()
		if (active.includes(TOOL_NAME)) {
			pi.setActiveTools(active.filter((n) => n !== TOOL_NAME))
		}
	})

	// ============================================================
	// Command: /explain
	// ============================================================
	pi.registerCommand("explain", {
		description: "Explain something using a rich, interactive HTML page",
		handler: async (args, ctx) => {
			const topic = args.trim()
			if (!topic) {
				ctx.ui.notify("Usage: /explain <what to explain>", "warning")
				return
			}

			if (!ctx.isIdle()) {
				ctx.ui.notify("Agent is busy, try again in a moment", "warning")
				return
			}

			// Activate the private tool so the LLM can see and use it this turn
			{
				const active: string[] = pi.getActiveTools()
				if (!active.includes(TOOL_NAME)) {
					pi.setActiveTools([...active, TOOL_NAME])
				}
			}

			pi.sendUserMessage([
				{
					type: "text" as const,
					text: [
						`Explain this using HTML: ${topic}`,
						"",
						"Create a beautifully styled, self-contained HTML page (one file, all CSS and JS embedded) that explains this concept clearly and engagingly.",
						"",
						"Guidelines:",
						"- Use SVG for diagrams, flowcharts, illustrations — wherever a diagram helps understanding",
						"- Use CSS for visual hierarchy, color coding, spacing, and typography that guides the eye",
						"- Add interactive elements where they help: expandable sections, tabs, syntax-highlighted code blocks, hoverable annotations",
						"- Include a clear title, structured sections, and a brief summary",
						"- Make it self-contained — no external fonts, libraries, or CDN links. Everything inline.",
						"- The page should be beautiful, readable, and informative on its own",
						"",
						"Use the create_html_page tool to save the result and open it in my browser.",
					].join("\n"),
				},
			])
		},
	})

	// After each agent turn, remove the private tool from the active set
	pi.on("agent_end", () => {
		const active: string[] = pi.getActiveTools()
		if (active.includes(TOOL_NAME)) {
			pi.setActiveTools(active.filter((n) => n !== TOOL_NAME))
		}
	})
}
