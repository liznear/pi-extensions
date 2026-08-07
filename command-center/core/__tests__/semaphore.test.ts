import { describe, expect, it } from "bun:test"
import { Semaphore } from "../semaphore.js"

describe("Semaphore", () => {
	it("allows acquiring up to concurrency limit", async () => {
		const sem = new Semaphore(2)
		let count = 0
		sem.acquire().then(() => count++)
		sem.acquire().then(() => count++)

		await new Promise((r) => setTimeout(r, 0))
		expect(count).toBe(2)
	})

	it("queues waiters when limit is reached", async () => {
		const sem = new Semaphore(1)
		let count = 0
		sem.acquire().then(() => count++)
		sem.acquire().then(() => count++)

		await new Promise((r) => setTimeout(r, 0))
		expect(count).toBe(1)

		sem.release()
		await new Promise((r) => setTimeout(r, 0))
		expect(count).toBe(2)
	})

	it("processes queue in FIFO order", async () => {
		const sem = new Semaphore(1)
		const order: number[] = []

		await sem.acquire() // holds the permit

		sem.acquire().then(() => order.push(1))
		sem.acquire().then(() => order.push(2))
		sem.acquire().then(() => order.push(3))

		sem.release()
		await new Promise((r) => setTimeout(r, 0))
		expect(order).toEqual([1])

		sem.release()
		await new Promise((r) => setTimeout(r, 0))
		expect(order).toEqual([1, 2])

		sem.release()
		await new Promise((r) => setTimeout(r, 0))
		expect(order).toEqual([1, 2, 3])
	})
})
