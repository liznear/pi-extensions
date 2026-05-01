import type { ToolResultMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { basename } from "node:path";

type TodoStatus = "pending" | "wip" | "completed" | "cancelled";

function formatCount(n: number): string {
	if (n < 1_000) return `${n}`;
	if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`;
	return `${(n / 1_000_000).toFixed(1)}m`;
}

function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;

	if (hours > 0) return `${hours}h${minutes}m${seconds}s`;
	if (minutes > 0) return `${minutes}m${seconds}s`;
	return `${seconds}s`;
}

function collectTodoCounts(ctx: ExtensionContext): { completed: number; total: number } {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const msg = branch[i]?.message as ToolResultMessage;
		if (msg?.role === "toolResult" && msg.toolName === "todo_write" && Array.isArray(msg.details?.todos)) {
			const todos = msg.details.todos as Array<{ status: TodoStatus }>;
			return { completed: todos.filter((t) => t.status === "completed").length, total: todos.length };
		}
	}
	return { completed: 0, total: 0 };
}

function applyCustomFooter(ctx: ExtensionContext, getLastRunDurationMs: () => number | undefined): void {
	ctx.ui.setFooter((tui, theme, footerData) => {
		const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
		const timer = setInterval(() => tui.requestRender(), 1000);

		return {
			dispose() {
				unsubscribe();
				clearInterval(timer);
			},
			invalidate() {},
			render(width: number): string[] {
				const sections: string[] = [];
				const mode = footerData.getExtensionStatuses().get("plan-mode") ? "Plan" : "Build";
				sections.push(theme.fg("dim", mode));

				if (ctx.model) {
					sections.push(theme.fg("dim", `${ctx.model.provider}/${ctx.model.id}`));
				}

				const contextUsage = ctx.getContextUsage();
				if (contextUsage && contextUsage.contextWindow > 0) {
					const { tokens, contextWindow, percent } = contextUsage;
					const usage = tokens !== null ? formatCount(tokens) : "?";
					
					let pct = percent !== null ? `${percent.toFixed(1)}%` : "?%";
					if (percent !== null && percent > 30) {
						pct = theme.fg(percent > 50 ? "error" : "warning", pct);
					}
					
					sections.push(theme.fg("dim", `${usage}/${formatCount(contextWindow)} ${pct}`));
				}

				const lastRunDurationMs = getLastRunDurationMs();
				if (lastRunDurationMs !== undefined) {
					sections.push(theme.fg("dim", formatDuration(lastRunDurationMs)));
				}

				const todo = collectTodoCounts(ctx);
				if (todo.total > 0) {
					const todoText = `TODO ${todo.completed}/${todo.total}`;
					if (todo.completed === todo.total) sections.push(theme.fg("success", todoText));
					else sections.push(theme.fg("warning", todoText));
				}

				const folder = basename(ctx.cwd);
				const branch = footerData.getGitBranch() ?? "-";
				const right = theme.fg("dim", `${folder} @ ${branch}`);

				const left = sections.join(" | ");
				const pad = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
				return [truncateToWidth(left + " ".repeat(pad) + right, width)];
			},
		};
	});
}

export default function customFooterExtension(pi: ExtensionAPI): void {
	let enabled = true;
	let currentRunStartedAtMs: number | undefined;
	let lastRunDurationMs: number | undefined;

	pi.on("agent_start", async () => {
		currentRunStartedAtMs = Date.now();
	});

	pi.on("agent_end", async () => {
		if (currentRunStartedAtMs !== undefined) {
			lastRunDurationMs = Date.now() - currentRunStartedAtMs;
			currentRunStartedAtMs = undefined;
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		if (enabled) applyCustomFooter(ctx, () => lastRunDurationMs);
	});

	pi.registerCommand("custom-footer", {
		description: "Enable/disable custom footer (always-on bottom status workaround)",
		handler: async (args, ctx) => {
			const action = (args ?? "").trim().toLowerCase();

			if (action === "off" || action === "disable") {
				enabled = false;
				ctx.ui.setFooter(undefined);
				ctx.ui.notify("Custom footer disabled (default footer restored)", "info");
				return;
			}

			if (action === "on" || action === "enable" || action === "") {
				enabled = true;
				applyCustomFooter(ctx, () => lastRunDurationMs);
				ctx.ui.notify("Custom footer enabled", "success");
				return;
			}

			ctx.ui.notify("Usage: /custom-footer [on|off]", "warning");
		},
	});
}
