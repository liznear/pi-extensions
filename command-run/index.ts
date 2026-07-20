/**
 * command-run Extension
 *
 * Batch + step tool runner. Lets the agent invoke several built-in tools
 * (bash, read, edit, write, grep, find, ls) in a SINGLE tool call, grouped
 * into ordered steps. Independent commands share a step and run in parallel;
 * commands that depend on earlier side effects use a later step. All results
 * return together, cutting LLM round-trips, token cost, and latency.
 *
 * Inspired by Tura's command_run tool:
 * https://github.com/Tura-AI/tura/blob/main/crates/tools/src/command_run/schema.json
 *
 * Tool (LLM-facing):
 *   command_run - Run a batch of built-in tool commands grouped by step.
 *
 * IMPORTANT caveats (inherent to in-process batching):
 *   - Sub-commands are dispatched directly to fresh built-in tool instances,
 *     so tool_call / tool_result hooks (permission gates, audit logging, etc.)
 *     do NOT fire for individual sub-commands. Only the top-level command_run
 *     call is intercepted as normal.
 *   - Built-in tools overridden by OTHER extensions are not respected here;
 *     sub-commands always run against the stock built-in implementations.
 *   - Image results (e.g. read on a PNG) are flattened to a "[image]" marker.
 *   - Each sub-command's output is truncated to keep the aggregate bounded.
 */

import { StringEnum } from "@earendil-works/pi-ai"
import type {
	AgentToolResult,
	ExtensionAPI,
} from "@earendil-works/pi-coding-agent"
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	formatSize,
	keyHint,
	truncateHead,
} from "@earendil-works/pi-coding-agent"
import { Text } from "@earendil-works/pi-tui"
import { Type } from "typebox"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Built-in tools command_run can dispatch to. */
const SUPPORTED_TOOLS = [
	"bash",
	"read",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
] as const

/** Per sub-command output budget. Each result is capped before aggregation. */
const PER_COMMAND_MAX_LINES = 80
const PER_COMMAND_MAX_BYTES = 4000

/** Final aggregate budget sent back to the model. */
const FINAL_MAX_LINES = 1500
const FINAL_MAX_BYTES = 45_000

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Permissive executor shape for the built-in tools (avoids importing AgentTool). */
interface AnyTool {
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
		onUpdate?: (partial: ToolExecResult) => void,
	) => Promise<ToolExecResult>
}

type ToolContent =
	| { type: "text"; text: string }
	| { type: "image"; source: unknown }

interface ToolExecResult {
	content: ToolContent[]
	details: unknown
	isError?: boolean
}

/** Outcome of a single sub-command. */
interface SubResult {
	index: number
	commandType: string
	detail?: string
	step: number
	status: "ok" | "error"
	output: string
	error?: string
	truncated?: boolean
	outputBytes?: number
	totalBytes?: number
}

/** Structured details stored on the command_run result (for rendering + state). */
interface CommandRunDetails {
	total?: number
	ok?: number
	failed?: number
	steps?: number
	running?: boolean
	commands?: Array<{
		index: number
		commandType: string
		detail?: string
		step: number
		status: "ok" | "error"
		error?: string
		truncated?: boolean
		preview?: string
	}>
}

// ---------------------------------------------------------------------------
// Dispatch cache (built-in tool instances per cwd)
// ---------------------------------------------------------------------------

const dispatchByCwd = new Map<string, Record<string, AnyTool>>()

function getDispatch(cwd: string): Record<string, AnyTool> {
	let dispatch = dispatchByCwd.get(cwd)
	if (!dispatch) {
		dispatch = {
			bash: createBashTool(cwd) as unknown as AnyTool,
			read: createReadTool(cwd) as unknown as AnyTool,
			edit: createEditTool(cwd) as unknown as AnyTool,
			write: createWriteTool(cwd) as unknown as AnyTool,
			grep: createGrepTool(cwd) as unknown as AnyTool,
			find: createFindTool(cwd) as unknown as AnyTool,
			ls: createLsTool(cwd) as unknown as AnyTool,
		}
		dispatchByCwd.set(cwd, dispatch)
	}
	return dispatch
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errorMessage(value: unknown): string {
	if (value instanceof Error) return value.message
	if (typeof value === "string") return value
	try {
		return JSON.stringify(value)
	} catch {
		return String(value)
	}
}

function normalizeStep(step: unknown): number {
	return typeof step === "number" && Number.isInteger(step) && step >= 1
		? step
		: 1
}

function formatCommandDetail(
	commandType: string,
	params: Record<string, unknown>,
): string {
	let detail = ""
	if (commandType === "bash" && typeof params.command === "string") {
		detail = params.command
	} else if (
		["read", "write", "edit", "ls"].includes(commandType) &&
		typeof params.path === "string"
	) {
		detail = params.path
	} else if (commandType === "grep" && typeof params.pattern === "string") {
		detail = params.pattern
		if (typeof params.path === "string") {
			detail += ` ${params.path}`
		}
	} else if (commandType === "find") {
		const parts = []
		if (typeof params.path === "string") parts.push(params.path)
		if (typeof params.pattern === "string")
			parts.push(`-name ${params.pattern}`)
		detail = parts.join(" ")
	}
	if (detail) {
		detail = detail.replace(/\r?\n/g, " ").trim()
		if (detail.length > 50) {
			detail = `${detail.substring(0, 47)}...`
		}
	}
	return detail
}

interface CommandJob {
	commandType: string
	parameters: Record<string, unknown>
	step: number
	index: number
}

async function runCommand(
	dispatch: Record<string, AnyTool>,
	job: CommandJob,
	signal: AbortSignal | undefined,
): Promise<SubResult> {
	const { commandType, parameters, step, index } = job
	const tool = dispatch[commandType]
	const detail = formatCommandDetail(commandType, parameters)
	const base = { index, commandType, detail, step }

	if (!tool) {
		return {
			...base,
			status: "error",
			output: "",
			error: `Unsupported command_type '${commandType}'. Supported: ${SUPPORTED_TOOLS.join(", ")}.`,
		}
	}

	try {
		const result = await tool.execute(
			`command_run#${index}`,
			parameters,
			signal,
		)
		const text = result.content
			.map((entry) => (entry.type === "text" ? entry.text : "[image]"))
			.join("\n")
			.trim()

		const truncation = truncateHead(text, {
			maxLines: PER_COMMAND_MAX_LINES,
			maxBytes: PER_COMMAND_MAX_BYTES,
		})

		return {
			...base,
			status: "ok",
			output: truncation.content,
			truncated: truncation.truncated,
			outputBytes: truncation.outputBytes,
			totalBytes: truncation.totalBytes,
		}
	} catch (error) {
		return { ...base, status: "error", output: "", error: errorMessage(error) }
	}
}

function summarize(results: SubResult[]): { ok: number; failed: number } {
	let ok = 0
	for (const result of results) {
		if (result.status === "ok") ok += 1
	}
	return { ok, failed: results.length - ok }
}

function buildPartialResult(
	results: SubResult[],
	stepCount: number,
	total: number,
): AgentToolResult<CommandRunDetails> {
	const { ok, failed } = summarize(results)
	return {
		content: [
			{
				type: "text",
				text: `Running\u2026 ${results.length}/${total} done \u2014 ${ok} ok, ${failed} failed.`,
			},
		],
		details: {
			total,
			ok,
			failed,
			steps: stepCount,
			running: true,
			commands: [],
		},
	}
}

function buildFinalResult(
	results: SubResult[],
	stepCount: number,
): AgentToolResult<CommandRunDetails> {
	const { ok, failed } = summarize(results)
	const lines: string[] = []
	lines.push(
		`command_run: ${results.length} command(s) across ${stepCount} step(s) \u2014 ${ok} ok, ${failed} failed.`,
	)
	lines.push("")

	let currentStep: number | undefined
	for (const result of results) {
		if (result.step !== currentStep) {
			currentStep = result.step
			lines.push(`\u2500\u2500 step ${result.step} \u2500\u2500`)
		}
		const mark = result.status === "ok" ? "\u2713" : "\u2717"
		const title = result.detail
			? `${result.commandType} ${result.detail}`
			: result.commandType
		lines.push(`[${mark}] #${result.index + 1} ${title}`)
		if (result.status === "error") {
			lines.push(`Error: ${result.error}`)
		} else if (result.output) {
			lines.push(result.output)
			if (result.truncated) {
				lines.push(
					`[output truncated: ${formatSize(result.outputBytes ?? 0)} of ${formatSize(
						result.totalBytes ?? result.outputBytes ?? 0,
					)}]`,
				)
			}
		} else {
			lines.push("(no output)")
		}
		lines.push("")
	}

	let text = lines.join("\n")
	const cap = truncateHead(text, {
		maxLines: FINAL_MAX_LINES,
		maxBytes: FINAL_MAX_BYTES,
	})
	if (cap.truncated) {
		text =
			cap.content +
			`\n\n[command_run aggregate truncated at ${formatSize(cap.outputBytes)} of ${formatSize(
				cap.totalBytes,
			)}. Re-run individual tools if you need full output.]`
	}

	return {
		content: [{ type: "text", text }],
		details: {
			total: results.length,
			ok,
			failed,
			steps: stepCount,
			commands: results.map((result) => ({
				index: result.index,
				commandType: result.commandType,
				detail: result.detail,
				step: result.step,
				status: result.status,
				error: result.error,
				truncated: result.truncated,
				preview: result.output.slice(0, 160),
			})),
		},
	}
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const commandSchema = Type.Object({
	command_type: StringEnum([...SUPPORTED_TOOLS], {
		description:
			"Target built-in tool name. `parameters` MUST match that tool's schema exactly.",
	}),
	parameters: Type.Record(Type.String(), Type.Unknown(), {
		description:
			"Arguments object matching command_type's schema. Examples: bash -> {command:'ls -la',timeout?:5000}; read -> {path:'src/index.ts',offset?,limit?}; edit -> {path,edits:[{oldText,newText}]}; write -> {path,content}; grep -> {pattern,path?}; find -> {path?,pattern?}; ls -> {path}.",
	}),
	step: Type.Optional(
		Type.Integer({
			minimum: 1,
			description:
				"Dependency group / execution order. Commands in the SAME step have no output dependency on each other and run in parallel. Commands that need earlier side effects (e.g. write-then-read, mkdir-then-run) MUST use a later step. Defaults to 1 when omitted.",
		}),
	),
})

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function commandRunExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "command_run",
		label: "Command Run",
		description:
			"Run a batch of built-in tool commands (bash/read/edit/write/grep/find/ls) grouped into ordered steps in ONE call. Independent commands share a step and run in parallel; dependent commands use later steps. All results return together, saving LLM round-trips, tokens, and latency. Only batch commands whose inputs are already known \u2014 you cannot branch on intermediate outputs within a single call.",
		promptSnippet:
			"Run many independent built-in tool calls (bash/read/edit/write/grep/find/ls) in ONE batch grouped by steps",
		promptGuidelines: [
			"Prefer command_run to execute several independent operations at once instead of many separate tool calls \u2014 it returns all results in a single round-trip, cutting token cost and latency.",
			"When using command_run, batch only commands whose inputs are already known now (it cannot branch on intermediate outputs). Group independent commands under the same step (parallel); put commands that need earlier side effects (write-then-read, mkdir-then-run) in later steps.",
			"Each command's parameters must match its command_type schema exactly: bash {command,timeout?}, read {path,offset?,limit?}, edit {path,edits:[{oldText,newText}]}, write {path,content}, grep {pattern,path?}, find {path?,pattern?}, ls {path}.",
		],
		parameters: Type.Object({
			commands: Type.Array(commandSchema, {
				minItems: 1,
				maxItems: 20,
				description:
					"Ordered command batch. Prefer 5+ commands for real tasks; 1-2 is fine for trivial lookups.",
			}),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const dispatch = getDispatch(ctx.cwd)
			const commands = params.commands

			// Group commands by step, preserving original index within each step.
			const groups = new Map<number, CommandJob[]>()
			commands.forEach((command, index) => {
				const step = normalizeStep(command.step)
				const bucket = groups.get(step) ?? []
				bucket.push({
					commandType: command.command_type,
					parameters: command.parameters,
					step,
					index,
				})
				groups.set(step, bucket)
			})
			const steps = [...groups.keys()].sort((a, b) => a - b)

			const results: SubResult[] = []
			for (const step of steps) {
				if (signal?.aborted) break
				const bucket = groups.get(step)
				if (!bucket) continue

				const batchResults = await Promise.all(
					bucket.map((job) => runCommand(dispatch, job, signal)),
				)
				results.push(...batchResults)
				onUpdate?.(buildPartialResult(results, steps.length, commands.length))
			}

			return buildFinalResult(results, steps.length)
		},

		renderCall(args, theme, context) {
			const text =
				(context.lastComponent as Text | undefined) ?? new Text("", 0, 0)

			const lines = [
				`${theme.fg("toolTitle", theme.bold("command_run "))}${theme.fg(
					"muted",
					`${args.commands.length} command(s)`,
				)}`,
			]

			const byStep = new Map<
				number,
				{ index: number; command: (typeof args.commands)[0] }[]
			>()
			args.commands.forEach((command, index) => {
				const step = normalizeStep(command.step)
				const bucket = byStep.get(step) ?? []
				bucket.push({ index, command })
				byStep.set(step, bucket)
			})

			for (const step of [...byStep.keys()].sort((a, b) => a - b)) {
				const bucket = byStep.get(step) ?? []
				if (byStep.size > 1) {
					lines.push(`${theme.fg("dim", `  step ${step}:`)}`)
				}
				for (const { index, command } of bucket) {
					const detail = formatCommandDetail(
						command.command_type,
						command.parameters || {},
					)
					const prefix = byStep.size > 1 ? "    " : "  "
					const formattedDetail = detail ? ` ${theme.fg("muted", detail)}` : ""
					lines.push(
						`${prefix}${theme.fg("dim", `#${index + 1}`)} ${theme.fg("toolTitle", command.command_type)}${formattedDetail}`,
					)
				}
			}

			text.setText(lines.join("\n"))
			return text
		},

		renderResult(result, options, theme, context) {
			const text =
				(context.lastComponent as Text | undefined) ?? new Text("", 0, 0)
			const details = (result.details ?? {}) as CommandRunDetails

			if (options.isPartial || details.running) {
				const progress = details.total
					? `Running\u2026 (${details.ok ?? 0} ok, ${details.failed ?? 0} failed so far)`
					: "Running\u2026"
				text.setText(theme.fg("warning", progress))
				return text
			}

			const ok = details.ok ?? 0
			const failed = details.failed ?? 0
			const header =
				failed === 0
					? theme.fg("success", `\u2713 ${ok} command(s) ok`)
					: theme.fg("warning", `${ok} ok, ${failed} failed`)

			const lines = [header]
			if (options.expanded && details.commands?.length) {
				for (const command of details.commands) {
					const mark = command.status === "ok" ? "\u2713" : "\u2717"
					const color = command.status === "ok" ? "success" : "error"
					const formattedDetail = command.detail
						? ` ${theme.fg("muted", command.detail)}`
						: ""
					lines.push(
						theme.fg(
							color,
							`  ${mark} #${command.index + 1} ${command.commandType}`,
						) + formattedDetail,
					)
					if (command.error) {
						lines.push(theme.fg("dim", `      ${command.error}`))
					}
				}
			} else if (!options.expanded) {
				lines[0] = `${header} (${keyHint("app.tools.expand", "expand for per-command status")})`
			}

			text.setText(lines.join("\n"))
			return text
		},
	})
}
