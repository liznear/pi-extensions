// ---------------------------------------------------------------------------
// Mission identity (ticket 06 D2).
//
// `missionId` is a generated, immutable 8-char base36 slug created at
// `define_mission`. Zero-friction, repo-unique, branch-safe. Backs both the
// git worktree namespace (cc/<missionId>/...) and the event stream identity.
// The human-facing label is the (mutable) Mission.title.
// ---------------------------------------------------------------------------

const MISSION_ID_LENGTH = 8

export type Rng = () => number

const defaultRng: Rng = Math.random

/**
 * Generate an 8-char base36 mission id.
 *
 * @param rng Optional RNG for testability (defaults to Math.random).
 */
export function generateMissionId(rng: Rng = defaultRng): string {
	let out = ""
	for (let i = 0; i < MISSION_ID_LENGTH; i++) {
		// floor(rand * 36) -> 0..35 -> base36 char [0-9a-z]
		const n = Math.floor(rng() * 36)
		out += n.toString(36)
	}
	return out
}

/** Validate that a value is a well-formed mission id (8 base36 chars). */
export function isMissionId(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-z]{8}$/.test(value)
}
