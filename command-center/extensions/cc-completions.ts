import type { AutocompleteItem } from "@earendil-works/pi-tui"
import type { MissionSummary } from "../core/types"

// ---------------------------------------------------------------------------
// /cc cursor-position completions
//
// Pure, dependency-free module wired into the TUI via an autocomplete-provider
// wrapper in cc.ts. Computes completions for the text before the cursor.
//
// Cursor grammar:
//   `/cc <sub-prefix>`          → subcommand-name completion
//   `/cc <subcommand> <prefix>` → mission-id completion (mission-id
//                                  subcommands only)
//   anything else               → null (delegate to the built-in provider)
//
// The returned `prefix` is the exact text to replace, so the TUI's
// applyCompletion swaps only the id token — NOT the whole argument text
// (the built-in slash-command provider replaces everything after `/cc `,
// which is what made Tab turn `/cc attach ` into `/cc some-id`).
// ---------------------------------------------------------------------------

interface Subcommand {
	name: string
	usage: string
}

/** The nine `/cc` subcommands, in the order they appear in cc.ts's handler. */
const SUBCOMMANDS: readonly Subcommand[] = [
	{ name: "list", usage: "List missions" },
	{ name: "start", usage: "Start a mission: /cc start <description>" },
	{
		name: "abort",
		usage: "Abort a mission or work item: /cc abort <missionId> [workItemId]",
	},
	{
		name: "delete",
		usage: "Delete a mission: /cc delete <missionId>",
	},
	{
		name: "attach",
		usage: "Attach to a mission session: /cc attach <missionId> [workItemId]",
	},
	{ name: "resume", usage: "Resume a mission: /cc resume <missionId>" },
	{
		name: "reply",
		usage:
			"Reply to a human input: /cc reply <missionId> <requestId> <message>",
	},
	{ name: "accept", usage: "Accept a mission: /cc accept <missionId>" },
	{
		name: "reject",
		usage: "Reject a mission: /cc reject <missionId> <feedback>",
	},
]

/** Subcommands whose second token is a mission id (list/start take none). */
const MISSION_ID_SUBCOMMANDS: ReadonlySet<string> = new Set(
	SUBCOMMANDS.filter((s) => s.name !== "list" && s.name !== "start").map(
		(s) => s.name,
	),
)

/** A completion: `prefix` is the exact text before the cursor to replace. */
export interface CcCompletion {
	prefix: string
	items: AutocompleteItem[]
}

const CC_PREFIX = /^\/cc/
/** `/cc <subcommand> <id-prefix>` — mission-id position (id-prefix may be ""). */
const MISSION_ID_POSITION = /^\/cc\s+(\S+)\s+(\S*)$/
/** `/cc <sub-prefix>` — subcommand position (sub-prefix may be ""). */
const SUBCOMMAND_POSITION = /^\/cc\s+(\S*)$/

/**
 * Compute `/cc` completions for the text before the cursor.
 *
 * Returns `null` when the cursor is not at a `/cc` completion site (the
 * provider wrapper then delegates to the built-in autocomplete provider) or
 * when nothing matches the prefix.
 */
export function ccCompletionForCursor(
	beforeCursor: string,
	missions: MissionSummary[],
): CcCompletion | null {
	if (!CC_PREFIX.test(beforeCursor)) return null

	// Mission-id position first: `/cc attach `, `/cc abort mi`.
	const idPos = MISSION_ID_POSITION.exec(beforeCursor)
	if (idPos) {
		const subcommand = idPos[1] ?? ""
		if (MISSION_ID_SUBCOMMANDS.has(subcommand.toLowerCase())) {
			const prefix = idPos[2] ?? ""
			const items = completeMissionId(prefix, missions)
			return items ? { prefix, items } : null
		}
	}

	// Subcommand position: `/cc `, `/cc at` (and, when the typed subcommand is
	// complete, `/cc attach` — a no-op menu that just re-offers it).
	const subPos = SUBCOMMAND_POSITION.exec(beforeCursor)
	if (subPos) {
		const prefix = subPos[1] ?? ""
		const items = completeSubcommand(prefix)
		return items ? { prefix, items } : null
	}

	return null
}

function completeSubcommand(prefix: string): AutocompleteItem[] | null {
	const needle = prefix.toLowerCase()
	const items = SUBCOMMANDS.filter((s) =>
		s.name.toLowerCase().startsWith(needle),
	).map((s) => ({
		value: s.name,
		label: s.name,
		description: s.usage,
	}))
	return items.length === 0 ? null : items
}

function completeMissionId(
	prefix: string,
	missions: MissionSummary[],
): AutocompleteItem[] | null {
	const needle = prefix.toLowerCase()
	const items = missions
		.filter(
			(m) =>
				m.id.toLowerCase().startsWith(needle) ||
				m.title.toLowerCase().includes(needle),
		)
		.map((m) => ({
			value: m.id,
			label: m.id,
			description: `${m.title} · ${m.status}`,
		}))
	return items.length === 0 ? null : items
}
