import { spawn } from "node:child_process";
import { type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { renderSteeringPrompt } from "./review-comments.js";
import { startReviewSession } from "./review-orchestration.js";
import { type WebReviewServer } from "./web-review.js";

function openBrowser(url: string): void {
	try {
		if (process.platform === "darwin") {
			spawn("open", [url], { stdio: "ignore", detached: true }).unref();
			return;
		}

		if (process.platform === "win32") {
			spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true }).unref();
			return;
		}

		spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
	} catch {
		// Ignore browser launch failures. URL is still shown to the user.
	}
}

export default function diffExtension(pi: ExtensionAPI): void {
	let activeServer: WebReviewServer | null = null;

	pi.registerCommand("diff", {
		description: "Open a web UI to review local changes (optionally against a target, e.g. /diff HEAD~1)",
		handler: async (args, ctx) => {
			const result = await startReviewSession({
				cwd: ctx.cwd,
				targetLabel: (args ?? "").trim() || "HEAD",
				existingServer: activeServer,
				onSubmit: (comments) => {
					if (comments.length === 0) return;

					pi.sendUserMessage(renderSteeringPrompt(comments), {
						deliverAs: "steer",
						triggerTurn: true,
					});

					ctx.ui.notify(`Received ${comments.length} comments from web UI!`, "success");
				},
			});

			if (!result.ok) {
				if (result.reason === "invalid-target") {
					ctx.ui.notify(`Invalid git target: ${result.targetLabel}`, "error");
					return;
				}

				ctx.ui.notify("No local changes to review.", "warning");
				return;
			}

			activeServer = result.server;
			ctx.ui.notify(`Web Review opened at: ${activeServer.url}`, "info");
			openBrowser(activeServer.url);
		},
	});
}
