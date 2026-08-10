import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import { getAllTweets, type TweetRecord } from "./db"

export const PORT = 3000

export type TweetWithReplies = TweetRecord & { replies: TweetWithReplies[] }

export function getRootTweets(): TweetWithReplies[] {
	const tweets = getAllTweets()
	const tweetMap = new Map<string, TweetWithReplies>()
	const rootTweets: TweetWithReplies[] = []

	// First pass: create map
	for (const t of tweets) {
		tweetMap.set(t.id, { ...t, replies: [] })
	}

	// Second pass: structure
	for (const t of tweets) {
		const tweetWithReplies = tweetMap.get(t.id)
		if (tweetWithReplies) {
			if (t.parent_id && tweetMap.has(t.parent_id)) {
				tweetMap.get(t.parent_id)?.replies.push(tweetWithReplies)
			} else {
				rootTweets.push(tweetWithReplies)
			}
		}
	}

	return rootTweets
}

export interface ServerLike {
	listening?: boolean
	stop?: (closeActiveConnections?: boolean) => void | Promise<void>
	close?: (callback?: (err?: Error) => void) => void
}

let serverInstance: ServerLike | null = null

export function isServerRunning(port = PORT): Promise<boolean> {
	if (serverInstance) {
		return Promise.resolve(true)
	}
	return fetch(`http://127.0.0.1:${port}/api/tweets`, {
		signal: AbortSignal.timeout(500),
	})
		.then((res) => res.ok)
		.catch(() => false)
}

export function startServer(port = PORT): Promise<ServerLike> {
	return new Promise((resolve, reject) => {
		if (serverInstance) {
			resolve(serverInstance)
			return
		}

		if (typeof Bun !== "undefined" && typeof Bun.serve === "function") {
			try {
				const server = Bun.serve({
					port,
					fetch(req) {
						const url = new URL(req.url)
						if (url.pathname === "/api/tweets") {
							try {
								return Response.json(getRootTweets())
							} catch (error) {
								console.error("Error fetching tweets:", error)
								return Response.json(
									{ error: "Internal Server Error" },
									{ status: 500 },
								)
							}
						}
						const indexPath = path.join(__dirname, "public", "index.html")
						if (fs.existsSync(indexPath)) {
							return new Response(Bun.file(indexPath))
						}
						return new Response("Not Found", { status: 404 })
					},
				})
				serverInstance = server
				resolve(server)
				return
			} catch (err) {
				reject(err)
				return
			}
		}

		// Node http fallback
		const server = http.createServer((req, res) => {
			const url = new URL(req.url || "/", `http://localhost:${port}`)
			if (url.pathname === "/api/tweets") {
				try {
					const rootTweets = getRootTweets()
					res.writeHead(200, { "Content-Type": "application/json" })
					res.end(JSON.stringify(rootTweets))
				} catch (error) {
					console.error("Error fetching tweets:", error)
					res.writeHead(500, { "Content-Type": "application/json" })
					res.end(JSON.stringify({ error: "Internal Server Error" }))
				}
				return
			}
			const indexPath = path.join(__dirname, "public", "index.html")
			fs.readFile(indexPath, (err, data) => {
				if (err) {
					res.writeHead(404, { "Content-Type": "text/plain" })
					res.end("Not Found")
					return
				}
				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
				res.end(data)
			})
		})

		server.listen(port, () => {
			serverInstance = server
			resolve(server)
		})
		server.on("error", (err) => {
			reject(err)
		})
	})
}

export function stopServer(): Promise<void> {
	return new Promise((resolve) => {
		if (serverInstance) {
			if (
				"stop" in serverInstance &&
				typeof serverInstance.stop === "function"
			) {
				serverInstance.stop()
				serverInstance = null
				resolve()
			} else if (
				"close" in serverInstance &&
				typeof serverInstance.close === "function"
			) {
				serverInstance.close(() => {
					serverInstance = null
					resolve()
				})
			} else {
				serverInstance = null
				resolve()
			}
		} else {
			resolve()
		}
	})
}

export async function ensureServerRunning(
	port = PORT,
): Promise<ServerLike | null> {
	const running = await isServerRunning(port)
	if (running) {
		return serverInstance
	}
	try {
		return await startServer(port)
	} catch (err) {
		if (
			typeof err === "object" &&
			err !== null &&
			"code" in err &&
			err.code === "EADDRINUSE"
		) {
			return null
		}
		throw err
	}
}

if (require.main === module) {
	startServer(PORT)
}
