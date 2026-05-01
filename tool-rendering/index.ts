import { createBashToolDefinition, type ExtensionAPI, keyHint, createReadToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

function formatReadLineRange(args: Record<string, unknown> | undefined): string {
	if (!args) return "";

	const start = typeof args.start === "number" ? args.start : undefined;
	const end = typeof args.end === "number" ? args.end : undefined;
	const startLine = typeof args.start_line === "number" ? args.start_line : undefined;
	const endLine = typeof args.end_line === "number" ? args.end_line : undefined;
	if (start !== undefined || end !== undefined || startLine !== undefined || endLine !== undefined) {
		const lineStart = startLine ?? start;
		const lineEnd = endLine ?? end;
		if (lineStart !== undefined && lineEnd !== undefined) return ` (${lineStart}-${lineEnd})`;
		if (lineStart !== undefined) return ` (from ${lineStart})`;
		if (lineEnd !== undefined) return ` (to ${lineEnd})`;
	}

	const offset = typeof args.offset === "number" ? args.offset : undefined;
	const limit = typeof args.limit === "number" ? args.limit : undefined;
	if (offset === undefined && limit === undefined) return "";

	const parts: string[] = [];
	if (offset !== undefined) parts.push(`offset=${offset}`);
	if (limit !== undefined) parts.push(`limit=${limit}`);
	return ` (${parts.join(", ")})`;
}

function isSkillPath(path: unknown): path is string {
	return typeof path === "string" && path.endsWith("SKILL.md");
}

export default function (pi: ExtensionAPI): void {
	const readToolDef = createReadToolDefinition(process.cwd());
	const bashToolDef = createBashToolDefinition(process.cwd());

	pi.registerTool({
		...readToolDef,
		renderCall: (args, theme, context) => {
			if (isSkillPath(args?.path)) {
				const parts = args.path.split("/");
				const skillName = parts.length >= 2 ? parts[parts.length - 2] : "skill";
				const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
				text.setText(theme.fg("toolTitle", theme.bold("⚡Load skill ")) + theme.fg("accent", skillName));
				return text;
			}

			if (!context.expanded) {
				const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
				const path = typeof args?.path === "string" ? args.path : "";
				const lineRange = formatReadLineRange(args as Record<string, unknown> | undefined);
				text.setText(theme.fg("toolTitle", theme.bold(`Read ${path}`)) + theme.fg("dim", lineRange));
				return text;
			}

			if (readToolDef.renderCall) return readToolDef.renderCall(args, theme, context);
			return (context.lastComponent as Text | undefined) ?? new Text(theme.fg("toolTitle", `read ${String(args?.path ?? "")}`), 0, 0);
		},
		renderResult: (result, options, theme, context) => {
			if (isSkillPath(context.args?.path)) {
				const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);

				if (options.isPartial) {
					text.setText(theme.fg("warning", "Loading..."));
					return text;
				}

				if (result.isError || result.details?.error) {
					text.setText(theme.fg("error", "Failed to load skill"));
					return text;
				}

				if (!options.expanded) {
					text.setText(
						theme.fg("success", "✓ Skill loaded into context") +
							` (${keyHint("app.tools.expand", "to read contents")})`,
					);
					return text;
				}
			}

			if (!options.expanded) {
				const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
				text.setText("");
				return text;
			}

			if (readToolDef.renderResult) return readToolDef.renderResult(result, options, theme, context);
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(result.content?.[0]?.text ?? "");
			return text;
		},
	});

	pi.registerTool({
		...bashToolDef,
		renderCall: (args, theme, context) => {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const command = typeof args?.command === "string" && args.command.length > 0 ? args.command : "...";
			const timeout = args?.timeout;
			const timeoutSuffix = typeof timeout === "number" ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
			text.setText(
				theme.fg("toolTitle", theme.bold(`$ ${command}`)) +
					timeoutSuffix +
					theme.fg("dim", ` (${keyHint("app.tools.expand", "to expand output")})`),
			);
			return text;
		},
		renderResult: (result, options, theme, context) => {
			if (options.expanded && bashToolDef.renderResult) {
				return bashToolDef.renderResult(result, options, theme, context);
			}

			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			if (options.isPartial) {
				text.setText(theme.fg("muted", "Running..."));
				return text;
			}
			if (result.isError) {
				text.setText(theme.fg("error", `Command failed (${keyHint("app.tools.expand", "to inspect")})`));
				return text;
			}
			text.setText("");
			return text;
		},
	});
}
