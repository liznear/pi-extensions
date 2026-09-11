/**
 * Annotate — interactive code & message review in pi powered by revdiff.
 *
 * Usage:
 *   /annotate              Interactive selection: last reply, git diff, or a file
 *   /annotate last         Annotate the agent's latest assistant message
 *   /annotate diff         Annotate working tree changes against HEAD (including untracked files)
 *   /annotate diff <base>  Annotate changes against a branch/ref (e.g. main)
 *   /annotate <path>       Annotate a specific file or folder (e.g. @src/index.ts)
 *
 * Annotations captured in revdiff are automatically fed back to pi as a user message.
 */

import { spawnSync } from "node:child_process"
import {
	type Dirent,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, isAbsolute, join, resolve } from "node:path"
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent"
import type { AutocompleteItem } from "@earendil-works/pi-tui"

const EXIT_CODE_ANNOTATIONS = 10
const EXIT_CODE_ON_ANNOTATIONS_ENV = "REVDIFF_EXIT_CODE_ON_ANNOTATIONS"

export function resolveRevdiffBin(): string | null {
	const custom = process.env.REVDIFF_BIN?.trim()
	if (custom) {
		if (existsSync(custom)) return custom
		return null
	}
	const pathDirs = (process.env.PATH ?? "").split(delimiter)
	for (const dir of pathDirs) {
		if (!dir) continue
		const candidate = join(dir, "revdiff")
		try {
			if (existsSync(candidate) && statSync(candidate).isFile()) {
				return candidate
			}
		} catch {
			// Ignore directory permission or lookup errors
		}
	}
	return null
}

export function extractLastAssistantText(
	entries: SessionEntry[],
): string | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]
		if (
			entry &&
			entry.type === "message" &&
			"message" in entry &&
			entry.message &&
			entry.message.role === "assistant"
		) {
			const content = entry.message.content
			if (typeof content === "string") return content
			if (Array.isArray(content)) {
				const parts: string[] = []
				for (const item of content) {
					if (typeof item === "string") {
						parts.push(item)
					} else if (
						item &&
						typeof item === "object" &&
						"text" in item &&
						typeof item.text === "string"
					) {
						parts.push(item.text)
					}
				}
				if (parts.length > 0) return parts.join("\n")
			}
		}
	}
	return null
}

function completePaths(prefix: string): AutocompleteItem[] | null {
	const partial = prefix.slice(1)
	const lastSlash = partial.lastIndexOf("/")
	const dir =
		lastSlash >= 0
			? join(process.cwd(), partial.slice(0, lastSlash + 1))
			: process.cwd()
	const fragment = partial.slice(lastSlash + 1)
	let entries: Dirent[]
	try {
		entries = readdirSync(dir, { withFileTypes: true })
	} catch {
		return null
	}
	const items = entries
		.filter(
			(entry) =>
				entry.name.startsWith(fragment) &&
				(fragment.startsWith(".") || !entry.name.startsWith(".")),
		)
		.sort((a, b) => a.name.localeCompare(b.name))
		.slice(0, 20)
		.map((entry) => {
			const rel = `${partial.slice(0, lastSlash + 1)}${entry.name}${entry.isDirectory() ? "/" : ""}`
			return { value: `@${rel}`, label: `@${rel}` }
		})
	return items.length > 0 ? items : null
}

async function completeDiffBase(
	pi: ExtensionAPI,
	fragment: string,
): Promise<AutocompleteItem[] | null> {
	const refs = await pi.exec("git", [
		"for-each-ref",
		"--format=%(refname:short)",
		"refs/heads",
		"refs/remotes",
		"refs/tags",
	])
	if (refs.code !== 0) return null
	const items = refs.stdout
		.split("\n")
		.filter((ref) => ref.startsWith(fragment))
		.slice(0, 20)
		.map((ref) => ({ value: `diff ${ref}`, label: ref }))
	return items.length > 0 ? items : null
}

export interface LaunchTarget {
	args: string[]
	label: string
	cleanupDir?: string
}

export type TargetResolution =
	| { ok: true; target: LaunchTarget }
	| { ok: false; message: string; level: "warning" | "error" }

export async function resolveTarget(
	_pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	rawTarget: string,
): Promise<TargetResolution> {
	const target = rawTarget.trim()

	if (target === "last") {
		const entries = ctx.sessionManager.getEntries()
		const text = extractLastAssistantText(entries)
		if (!text?.trim()) {
			return {
				ok: false,
				message: "No assistant message found to annotate",
				level: "warning",
			}
		}
		const tmp = mkdtempSync(join(tmpdir(), "pi-annotate-last-"))
		const filePath = join(tmp, "last-assistant-message.md")
		writeFileSync(filePath, text, "utf8")
		return {
			ok: true,
			target: {
				args: ["--only", filePath],
				label: "last reply",
				cleanupDir: tmp,
			},
		}
	}

	if (target === "diff" || target.startsWith("diff ")) {
		const base = target === "diff" ? "HEAD" : target.slice(5).trim() || "HEAD"
		return {
			ok: true,
			target: {
				args: [base, "--untracked"],
				label: base === "HEAD" ? "git diff" : `git diff ${base}`,
			},
		}
	}

	const cleanPath = target.replace(/^@/, "")
	const abs = isAbsolute(cleanPath) ? cleanPath : resolve(ctx.cwd, cleanPath)

	if (!existsSync(abs)) {
		return {
			ok: false,
			message: `Path not found: ${abs}`,
			level: "error",
		}
	}

	return {
		ok: true,
		target: {
			args: ["--only", abs],
			label: cleanPath,
		},
	}
}

async function runRevdiff(
	ctx: ExtensionCommandContext,
	revdiffBin: string,
	target: LaunchTarget,
): Promise<{ feedback: string; exitCode: number | null }> {
	const tmp = mkdtempSync(join(tmpdir(), "pi-annotate-out-"))
	const outputFile = join(tmp, "annotations.txt")
	const args = [...target.args, `--output=${outputFile}`]

	let exitStatus: number | null = null

	await ctx.ui.custom<void>((tui, _theme, _kb, done) => {
		tui.stop()
		process.stdout.write("\x1b[2J\x1b[H")
		const env = {
			...process.env,
			[EXIT_CODE_ON_ANNOTATIONS_ENV]: "true",
		}
		const res = spawnSync(revdiffBin, args, {
			cwd: ctx.cwd,
			stdio: "inherit",
			env,
		})
		exitStatus = res.status
		tui.start()
		tui.requestRender(true)
		done()
		return { render: () => [], invalidate() {} }
	})

	let feedback = ""
	if (existsSync(outputFile)) {
		try {
			feedback = readFileSync(outputFile, "utf8").trim()
		} catch {
			// ignore file read errors
		}
	}

	try {
		rmSync(tmp, { recursive: true, force: true })
		if (target.cleanupDir) {
			rmSync(target.cleanupDir, { recursive: true, force: true })
		}
	} catch {
		// ignore cleanup error
	}

	return { feedback, exitCode: exitStatus }
}

export default function annotateExtension(pi: ExtensionAPI): void {
	pi.registerCommand("annotate", {
		description:
			"Review and annotate last reply, git diff, or file with revdiff; comments return to the agent",
		getArgumentCompletions: async (
			prefix: string,
		): Promise<AutocompleteItem[] | null> => {
			if (prefix.startsWith("@")) return completePaths(prefix)
			if (prefix.startsWith("diff "))
				return completeDiffBase(pi, prefix.slice(5))
			const items: AutocompleteItem[] = [
				{
					value: "last",
					label: "last",
					description: "Annotate the agent's newest reply",
				},
				{
					value: "diff",
					label: "diff",
					description:
						"Annotate git diff vs HEAD with untracked files; or diff <base>",
				},
			]
			const filtered = items.filter((item) => item.value.startsWith(prefix))
			return filtered.length > 0 ? filtered : null
		},
		handler: async (rawArgs, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/annotate requires interactive pi TUI mode", "warning")
				return
			}

			const revdiffBin = resolveRevdiffBin()
			if (!revdiffBin) {
				ctx.ui.notify(
					'revdiff binary not found. Install via "brew install umputun/apps/revdiff" or set REVDIFF_BIN.',
					"error",
				)
				return
			}

			let target = rawArgs.trim()
			if (!target) {
				const choice = await ctx.ui.select("Annotate what?", [
					"last",
					"diff",
					"file",
				])
				if (!choice) return
				if (choice === "file") {
					const path = await ctx.ui.input("File or folder to annotate:", "path")
					if (!path?.trim()) return
					target = path.trim()
				} else {
					target = choice
				}
			}

			const res = await resolveTarget(pi, ctx, target)
			if (!res.ok) {
				ctx.ui.notify(res.message, res.level)
				return
			}

			const { feedback, exitCode } = await runRevdiff(
				ctx,
				revdiffBin,
				res.target,
			)

			if (
				exitCode !== 0 &&
				exitCode !== EXIT_CODE_ANNOTATIONS &&
				exitCode !== null
			) {
				ctx.ui.notify(`revdiff exited with code ${exitCode}`, "warning")
				return
			}

			if (feedback) {
				pi.sendUserMessage(
					feedback,
					ctx.isIdle() ? undefined : { deliverAs: "followUp" },
				)
			} else {
				ctx.ui.notify(
					`Closed "${res.target.label}" without annotations`,
					"info",
				)
			}
		},
	})
}
