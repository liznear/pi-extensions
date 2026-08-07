import { describe, expect, test } from "bun:test"
import { generateMissionId, isMissionId } from "../identity"

describe("generateMissionId", () => {
	test("is 8 base36 characters [0-9a-z]", () => {
		for (let i = 0; i < 200; i++) {
			const id = generateMissionId()
			expect(id).toHaveLength(8)
			expect(id).toMatch(/^[0-9a-z]{8}$/)
		}
	})

	test("is branch-safe (no uppercase, no special chars)", () => {
		for (let i = 0; i < 100; i++) {
			const id = generateMissionId()
			// branch-safe: lowercase alnum only
			expect(id).not.toMatch(/[A-Z/_.-]/)
		}
	})

	test("is well-distributed (collisions rare over many draws)", () => {
		const seen = new Set<string>()
		const N = 5000
		for (let i = 0; i < N; i++) {
			seen.add(generateMissionId())
		}
		// 8 base36 chars = 36^8 ≈ 2.8e12 space; 5000 draws should be collision-free
		// with overwhelming probability (birthday bound ≈ 1.7e6 before 50%).
		expect(seen.size).toBe(N)
	})

	test("deterministic from a seeded RNG (reproducible)", () => {
		// The function accepts an optional RNG for testability.
		let seed = 42
		const rng = () => {
			// simple LCG for deterministic test
			seed = (seed * 1103515245 + 12345) & 0x7fffffff
			return seed / 0x7fffffff
		}
		const a = generateMissionId(rng)
		seed = 42
		const b = generateMissionId(rng)
		expect(a).toBe(b)
	})
})

describe("isMissionId", () => {
	test("accepts a valid 8-char base36 string", () => {
		expect(isMissionId("7k3a9fq")).toBe(false) // 7 chars
		expect(isMissionId("7k3a9fqa")).toBe(true)
		expect(isMissionId("00000000")).toBe(true)
		expect(isMissionId("zzzzzzzz")).toBe(true)
	})

	test("rejects invalid shapes", () => {
		expect(isMissionId("")).toBe(false)
		expect(isMissionId("ABCDEF12")).toBe(false) // uppercase
		expect(isMissionId("7k3a9fq!")).toBe(false) // special char
		expect(isMissionId("7k3a9fqa0")).toBe(false) // too long
		expect(isMissionId(12345678)).toBe(false) // not a string
	})
})
