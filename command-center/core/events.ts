import type { AssistantMessage } from "@earendil-works/pi-ai"
import type {
	Mission,
	MissionStatus,
	Plan,
	RoleName,
	WorkItemStatus,
} from "./types"

// ---------------------------------------------------------------------------
// Event vocabulary (ticket 01).
//
// One unified, Orchestrator-owned event stream. A flat discriminated union on a
// `type` field. Every event carries a common base { type, ts, seq }:
//   - `ts`  = epoch ms (when it happened)
//   - `seq` = monotonic per-bus counter for total order
//
// Naming: kebab-case past-tense string literals (these are facts); PascalCase
// TS type names mirror the literal.
//
// Role identity threads via `roleName` + `workItemId?` (present ⇒ owner of that
// item; absent ⇒ the mission lead). `sessionId` appears ONLY on the two
// lifecycle events where the session is the subject; there is NO `roleId`.
// ---------------------------------------------------------------------------

/** The common base stamped onto every emitted event by the EventBus. */
export interface EventBase {
	type: string
	ts: number
	seq: number
}

/** Role identity fragment used by forwarded/derived events. */
export interface EventRoleRef {
	missionId: string
	roleName: RoleName
	workItemId?: number
}

/** The agent/role that caused a domain transition (for `causedBy`). */
export interface CausedBy {
	roleName: RoleName
	workItemId?: number
}

// ---------------------------------------------------------------------------
// Domain events — Orchestrator-origin (emitted from its own logic)
// ---------------------------------------------------------------------------

export interface MissionDefinedEvent extends EventBase {
	type: "mission-defined"
	missionId: string
	mission: Mission
}
export interface PlanWrittenEvent extends EventBase {
	type: "plan-written"
	missionId: string
	plan: Plan
}
export interface WorkItemStatusChangedEvent extends EventBase {
	type: "work-item-status-changed"
	missionId: string
	workItemId: number
	from: WorkItemStatus
	to: WorkItemStatus
	causedBy?: CausedBy
}
export interface MissionStatusChangedEvent extends EventBase {
	type: "mission-status-changed"
	missionId: string
	from: MissionStatus
	to: MissionStatus
}
/** Emitted when a mission is fully deleted (worktrees, branches, persisted state). */
export interface MissionDeletedEvent extends EventBase {
	type: "mission-deleted"
	missionId: string
}
export interface MemoryUpdatedEvent extends EventBase, EventRoleRef {
	type: "memory-updated"
	content: string
}
export interface SessionStartedEvent extends EventBase, EventRoleRef {
	type: "session-started"
	sessionId: string
}
export interface HumanInputRequestedEvent extends EventBase, EventRoleRef {
	type: "human-input-requested"
	requestId: string
	question: string
	options?: string[]
}
export interface HumanInputRepliedEvent extends EventBase, EventRoleRef {
	type: "human-input-replied"
	requestId: string
	reply: string
}
export interface StatusReportedEvent extends EventBase, EventRoleRef {
	type: "status-reported"
	summary: string
}

export interface HelpRequestedEvent extends EventBase, EventRoleRef {
	type: "help-requested"
	reason: string
}
export interface HelpRespondedEvent extends EventBase, EventRoleRef {
	type: "help-responded"
	outcome: "guided" | "cancelled"
	guidance?: string
}

// ---------------------------------------------------------------------------
// Forwarded events — re-wrapped from pi SDK session events (content originates
// in the agent session; the Orchestrator's normalization layer emits these).
// ---------------------------------------------------------------------------

export interface SessionEndedEvent extends EventBase, EventRoleRef {
	type: "session-ended"
	sessionId: string
}
export interface MessageDeltaEvent extends EventBase, EventRoleRef {
	type: "message-delta"
	delta: string
}
export interface ReasoningDeltaEvent extends EventBase, EventRoleRef {
	type: "reasoning-delta"
	delta: string
}
export interface ToolCallStartedEvent extends EventBase, EventRoleRef {
	type: "tool-call-started"
	toolCallId: string
	toolName: string
	args: unknown
}
export interface ToolCallEndedEvent extends EventBase, EventRoleRef {
	type: "tool-call-ended"
	toolCallId: string
	toolName: string
	result: unknown
	isError: boolean
}
export interface MessageEndedEvent extends EventBase, EventRoleRef {
	type: "message-ended"
	message: AssistantMessage
}

// ---------------------------------------------------------------------------
// The union
// ---------------------------------------------------------------------------

/** The full set of events the library emits. */
export type Event =
	| MissionDefinedEvent
	| PlanWrittenEvent
	| WorkItemStatusChangedEvent
	| MissionStatusChangedEvent
	| MissionDeletedEvent
	| MemoryUpdatedEvent
	| SessionStartedEvent
	| HumanInputRequestedEvent
	| HumanInputRepliedEvent
	| StatusReportedEvent
	| HelpRequestedEvent
	| HelpRespondedEvent
	| SessionEndedEvent
	| MessageDeltaEvent
	| ReasoningDeltaEvent
	| ToolCallStartedEvent
	| ToolCallEndedEvent
	| MessageEndedEvent

/** Distributive Omit — applies per union member so each keeps its own fields. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
	? Omit<T, K>
	: never

/** An event payload WITHOUT the auto-stamped {ts, seq} — what callers hand to emit.
 *  The `type` discriminator is caller-supplied and is NOT stripped. */
export type EmittableEvent = DistributiveOmit<Event, "ts" | "seq">

/** A listener invoked synchronously for each emitted event. */
export type EventListener = (event: Event) => void

// ---------------------------------------------------------------------------
// EventBus
//
// The Orchestrator owns one. `seq` is per-bus monotonic; `ts` is epoch ms.
// `emit` stamps the event, fans out to all listeners synchronously, and
// returns the stamped event so the emitter can keep a handle to it.
// ---------------------------------------------------------------------------

export class EventBus {
	private seq = 0
	private listeners = new Set<EventListener>()

	/** Subscribe to all events. Returns an unsubscribe function. */
	subscribe(listener: EventListener): () => void {
		this.listeners.add(listener)
		return () => {
			this.listeners.delete(listener)
		}
	}

	/** Stamp a payload with {ts, seq} and fan it out to all listeners. */
	emit(payload: EmittableEvent): Event {
		const seq = this.seq++
		const event = {
			ts: Date.now(),
			seq,
			...payload,
		} as Event
		for (const listener of this.listeners) {
			listener(event)
		}
		return event
	}
}
