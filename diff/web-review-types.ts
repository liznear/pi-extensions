import type http from "node:http"

export interface ReviewComment {
	file: string
	line: string
	side: "old" | "new"
	comment: string
}

export interface WebReviewServerOptions {
	cwd: string
	target?: string
	targetLabel?: string
	port?: number
	onSubmit?: (comments: ReviewComment[]) => void | Promise<void>
}

export interface WebReviewServer {
	port: number
	url: string
	server: http.Server
	close: () => Promise<void>
}

export interface RenderedFile {
	path: string
	hunks: RenderedHunk[]
}

export interface RenderedHunk {
	header: string
	oldStart: number
	oldCount: number
	newStart: number
	newCount: number
	lines: RenderedLine[]
}

export interface RenderedLine {
	type: "context" | "added" | "removed"
	oldLine?: number
	newLine?: number
	content: string
}

interface ContextLine {
	line: number
	content: string
}

export interface ContextRow {
	oldLine?: number
	oldContent?: string
	newLine?: number
	newContent?: string
}

export type { ContextLine }
