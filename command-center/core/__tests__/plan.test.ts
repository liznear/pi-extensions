import { describe, expect, test } from "bun:test"
import { mergePlan } from "../tools/plan"
import type { Plan, WorkItem } from "../types"

function wi(
	over: Partial<WorkItem> & Pick<WorkItem, "id" | "title">,
): WorkItem {
	return {
		id: over.id,
		title: over.title,
		description: over.description ?? "",
		dependencies: over.dependencies ?? [],
		status: over.status ?? "pending",
	}
}

// ---------------------------------------------------------------------------
// mergePlan (ticket 05 D6) — the write_plan append-only seam.
//   - New items (id not in current) are appended with the next sequential id;
//     their status starts at "pending".
//   - Existing non-terminal items: title/description/deps editable.
//   - Existing terminal items (accepted/cancelled): title/description editable,
//     but dependency edges are FROZEN (kept from current).
//   - Items in current but absent from input are RETAINED (never deleted).
//   - Input items may omit `id` to request a new append.
// ---------------------------------------------------------------------------

describe("mergePlan", () => {
	test("null current + new items → assigns sequential ids from 1, status pending", () => {
		const out = mergePlan(null, {
			items: [
				{ title: "A", description: "a", dependencies: [] },
				{ title: "B", description: "b", dependencies: [1] },
			],
		})
		expect(out.items).toEqual([
			wi({ id: 1, title: "A", description: "a", dependencies: [] }),
			wi({ id: 2, title: "B", description: "b", dependencies: [1] }),
		])
	})

	test("appends new items after existing, continuing the id sequence", () => {
		const current: Plan = {
			items: [wi({ id: 1, title: "A", status: "accepted" })],
		}
		const out = mergePlan(current, {
			items: [
				{ id: 1, title: "A", description: "", dependencies: [] },
				{ title: "B", description: "", dependencies: [1] },
			],
		})
		expect(out.items.map((i) => i.id)).toEqual([1, 2])
		expect(out.items[1]?.status).toBe("pending")
	})

	test("rejects items absent from input (no deletion)", () => {
		const current: Plan = {
			items: [
				wi({ id: 1, title: "A" }),
				wi({ id: 2, title: "B" }),
				wi({ id: 3, title: "C" }),
			],
		}
		expect(() => mergePlan(current, { items: [] })).toThrow(
			/missing from the input/,
		)
	})

	test("updates mutable fields on a non-terminal item", () => {
		const current: Plan = {
			items: [wi({ id: 1, title: "A", description: "old", dependencies: [] })],
		}
		const out = mergePlan(current, {
			items: [
				{
					id: 1,
					title: "A2",
					description: "new",
					dependencies: [],
				},
			],
		})
		expect(out.items[0]).toEqual(
			wi({
				id: 1,
				title: "A2",
				description: "new",
				dependencies: [],
				status: "pending",
			}),
		)
	})

	test("edits dependency edges on a non-terminal item", () => {
		const current: Plan = {
			items: [
				wi({ id: 1, title: "A", dependencies: [] }),
				wi({ id: 2, title: "B", dependencies: [1] }),
			],
		}
		const out = mergePlan(current, {
			items: [
				{ id: 1, title: "A", description: "", dependencies: [] },
				{ id: 2, title: "B", description: "", dependencies: [] },
			],
		})
		expect(out.items.find((i) => i.id === 2)?.dependencies).toEqual([])
	})

	test("REJECTS deps edits on a terminal (accepted) item", () => {
		const current: Plan = {
			items: [
				wi({ id: 1, title: "A", dependencies: [] }),
				wi({ id: 2, title: "B", dependencies: [1], status: "accepted" }),
			],
		}
		// lead tries to change B's deps post-accept → throws
		expect(() =>
			mergePlan(current, {
				items: [
					{ id: 1, title: "A", description: "", dependencies: [] },
					{ id: 2, title: "B", description: "", dependencies: [] },
				],
			}),
		).toThrow(/Cannot modify dependencies/)
	})

	test("REJECTS deps edits on a cancelled item too", () => {
		const current: Plan = {
			items: [
				wi({ id: 1, title: "A", dependencies: [2], status: "cancelled" }),
			],
		}
		expect(() =>
			mergePlan(current, {
				items: [{ id: 1, title: "A2", description: "", dependencies: [] }],
			}),
		).toThrow(/Cannot modify dependencies/)
	})

	test("does not regress an existing item's status back to pending", () => {
		const current: Plan = {
			items: [wi({ id: 1, title: "A", status: "in_progress" })],
		}
		const out = mergePlan(current, {
			items: [{ id: 1, title: "A", description: "", dependencies: [] }],
		})
		// status is preserved from current (write_plan never manages status)
		expect(out.items[0]?.status).toBe("in_progress")
	})

	test("mix: append + frozen + update in one call", () => {
		const current: Plan = {
			items: [
				wi({ id: 1, title: "A", dependencies: [], status: "accepted" }),
				wi({ id: 2, title: "B", dependencies: [1], status: "in_progress" }),
			],
		}
		const out = mergePlan(current, {
			items: [
				{ id: 1, title: "A-renamed", description: "", dependencies: [] }, // frozen deps
				{ id: 2, title: "B2", description: "edited", dependencies: [1] }, // editable
				{ title: "D", description: "new", dependencies: [1, 2] }, // appended → id 3
			],
		})
		expect(out.items.map((i) => i.id)).toEqual([1, 2, 3])
		expect(out.items.find((i) => i.id === 1)?.title).toBe("A-renamed")
		expect(out.items.find((i) => i.id === 1)?.status).toBe("accepted")
		expect(out.items.find((i) => i.id === 2)?.title).toBe("B2")
		expect(out.items.find((i) => i.id === 2)?.description).toBe("edited")
		expect(out.items.find((i) => i.id === 3)?.dependencies).toEqual([1, 2])
	})
})
