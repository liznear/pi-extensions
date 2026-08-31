/**
 * /graph command surface — run | steer | abort | resume | gc | delete (RFC §7).
 * Scaffold stubs: parse and acknowledge; implementation lands with ticket 10.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

const USAGE =
	"usage: /graph run <graph-id> [brief…] | steer <actor> <text> | abort | resume <run-id> | gc [--days N] | delete <run-id>"

export function registerCommands(pi: ExtensionAPI) {
	pi.registerCommand("graph", {
		description: "Actor graph: run | steer | abort | resume | gc | delete",
		handler: async (args, ctx) => {
			const [sub, ...rest] = args.trim().split(/\s+/)
			switch (sub) {
				case "run":
					ctx.ui.notify(
						`graph run ${rest.join(" ")}: not implemented yet (ticket 10)`,
						"info",
					)
					break
				case "steer":
					ctx.ui.notify(
						`graph steer ${rest.join(" ")}: not implemented yet (ticket 10)`,
						"info",
					)
					break
				case "abort":
					ctx.ui.notify("graph abort: not implemented yet (ticket 10)", "info")
					break
				case "resume":
					ctx.ui.notify(
						`graph resume ${rest.join(" ")}: not implemented yet (ticket 10)`,
						"info",
					)
					break
				case "gc":
					ctx.ui.notify(
						`graph gc ${rest.join(" ")}: not implemented yet (ticket 10)`,
						"info",
					)
					break
				case "delete":
					ctx.ui.notify(
						`graph delete ${rest.join(" ")}: not implemented yet (ticket 10)`,
						"info",
					)
					break
				default:
					ctx.ui.notify(USAGE, "info")
			}
		},
	})
}
