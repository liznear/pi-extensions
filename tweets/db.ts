import { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/**
 * Ensures the ~/.pi/tweets directory exists and returns the full path to the database file.
 */
export function getDatabasePath(): string {
	const homedir = os.homedir()
	const dir = path.join(homedir, ".pi", "tweets")
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true })
	}
	return path.join(dir, "tweets.db")
}

/**
 * Initializes the SQLite database for tweets, creating the necessary tables if they don't exist.
 */
export function initDatabase(): Database {
	const dbPath = getDatabasePath()
	const db = new Database(dbPath)

	db.exec(`
		CREATE TABLE IF NOT EXISTS tweets (
			id TEXT PRIMARY KEY,
			parent_id TEXT,
			content TEXT NOT NULL,
			tags TEXT,
			model_name TEXT,
			repo_path TEXT,
			timestamp DATETIME NOT NULL
		);
	`)

	return db
}

export interface TweetRecord {
	id: string
	parent_id: string | null
	content: string
	tags: string | null
	model_name: string
	repo_path: string
	timestamp: string
}

/**
 * Inserts a new tweet into the database.
 */
export function insertTweet(
	content: string,
	tags: string[],
	model_name: string,
	repo_path: string,
): string {
	const db = initDatabase()
	const id = randomUUID()
	const timestamp = new Date().toISOString()
	const tagsStr = JSON.stringify(tags)

	const stmt = db.prepare(`
		INSERT INTO tweets (id, parent_id, content, tags, model_name, repo_path, timestamp)
		VALUES (?, NULL, ?, ?, ?, ?, ?)
	`)
	stmt.run(id, content, tagsStr, model_name, repo_path, timestamp)
	db.close()
	return id
}

/**
 * Inserts a reply to an existing tweet.
 */
export function insertReply(
	parent_id: string,
	content: string,
	model_name: string,
	repo_path: string,
): string {
	const db = initDatabase()
	const id = randomUUID()
	const timestamp = new Date().toISOString()

	const stmt = db.prepare(`
		INSERT INTO tweets (id, parent_id, content, tags, model_name, repo_path, timestamp)
		VALUES (?, ?, ?, NULL, ?, ?, ?)
	`)
	stmt.run(id, parent_id, content, model_name, repo_path, timestamp)
	db.close()
	return id
}

/**
 * Searches for tweets matching a keyword in content or tags for a specific repo_path.
 */
export function searchTweets(
	keyword: string,
	repo_path: string,
): TweetRecord[] {
	const db = initDatabase()
	const stmt = db.prepare(`
		SELECT * FROM tweets
		WHERE repo_path = ? AND (content LIKE ? OR tags LIKE ?)
		ORDER BY timestamp DESC
	`)
	const likeKeyword = `%${keyword}%`
	const results = stmt.all(repo_path, likeKeyword, likeKeyword) as TweetRecord[]
	db.close()
	return results
}

/**
 * Returns all tweets, ordered by timestamp ascending so threads can be reconstructed.
 */
export function getAllTweets(): TweetRecord[] {
	const db = initDatabase()
	const stmt = db.prepare(`
		SELECT * FROM tweets
		ORDER BY timestamp ASC
	`)
	const results = stmt.all() as TweetRecord[]
	db.close()
	return results
}
