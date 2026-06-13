import http from "node:http"
import { handleReviewRequest } from "./review-http.js"
import type {
	WebReviewServer,
	WebReviewServerOptions,
} from "./web-review-types.js"

export { getGitDiff, resolveGitTarget } from "./diff-source.js"
export type {
	ReviewComment,
	WebReviewServer,
	WebReviewServerOptions,
} from "./web-review-types.js"

export async function createWebReviewServer(
	options: WebReviewServerOptions,
): Promise<WebReviewServer> {
	const server = http.createServer((req, res) => {
		void handleReviewRequest(req, res, options)
	})

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject)
		server.listen(options.port ?? 0, "127.0.0.1", () => {
			server.off("error", reject)
			resolve()
		})
	})

	const address = server.address()
	if (!address || typeof address === "string") {
		throw new Error("Failed to bind web review server")
	}

	return {
		port: address.port,
		url: `http://localhost:${address.port}`,
		server,
		close: () =>
			new Promise((resolve, reject) =>
				server.close((err) => (err ? reject(err) : resolve())),
			),
	}
}
