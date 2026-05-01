import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/**
 * Extra guard extension used by /review isolated subprocess.
 * Keeps reviewer in read-only mode while still allowing other extensions/tools (e.g. web tools).
 */
function isAllowedReviewBash(command: string): boolean {
	const cmd = command.trim();
	if (!cmd) return false;
	if (/\n|;|&&|\|\|/.test(cmd)) return false;
	return /^git\s+(status|diff)\b/i.test(cmd);
}

export default function reviewReadonlyGuard(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event) => {
		if (event.toolName === "edit" || event.toolName === "write") {
			return {
				block: true,
				reason: `Read-only review mode: tool '${event.toolName}' is blocked`,
			};
		}

		if (event.toolName === "bash") {
			const command = typeof event.input.command === "string" ? event.input.command : "";
			if (!isAllowedReviewBash(command)) {
				return {
					block: true,
					reason: "Read-only review mode: only 'git status' and 'git diff' are allowed via bash",
				};
			}
		}
	});
}
