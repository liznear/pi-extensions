/**
 * actor-graph — message-driven actor graph runner.
 *
 * Parses a graph YAML from ~/.pi/graphs/ and executes it as headless,
 * intercom-addressed actor sessions (spec: plans/actor-graph-rfc.md).
 * Entry point: registers the /graph command; later slices add the progress
 * widget (ticket 11) and the intercom observation channel (ticket 10).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { registerCommands } from "./src/commands"

export default function (pi: ExtensionAPI) {
	registerCommands(pi)
}
