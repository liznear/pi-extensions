export class Semaphore {
	private permits: number
	private waiters: Array<() => void> = []

	constructor(concurrency: number) {
		this.permits = concurrency
	}

	async acquire(): Promise<void> {
		if (this.permits > 0) {
			this.permits--
			return Promise.resolve()
		}
		return new Promise((resolve) => {
			this.waiters.push(resolve)
		})
	}

	release(): void {
		if (this.waiters.length > 0) {
			const resolve = this.waiters.shift()
			if (resolve) {
				resolve()
			}
		} else {
			this.permits++
		}
	}
}
