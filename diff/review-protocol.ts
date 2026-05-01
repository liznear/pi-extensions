import type { ContextRow, ReviewComment } from "./web-review-types.js";
import { normalizeReviewComments } from "./review-comments.js";

export const REVIEW_ROUTES = {
	root: "/",
	context: "/context",
	submit: "/submit",
	close: "/close",
} as const;

export const CONTEXT_QUERY_KEYS = {
	file: "file",
	oldStart: "oldStart",
	oldEnd: "oldEnd",
	newStart: "newStart",
	newEnd: "newEnd",
} as const;

export interface ContextRequest {
	file: string;
	oldStart: number;
	oldEnd: number;
	newStart: number;
	newEnd: number;
}

export interface ContextResponse {
	rows: ContextRow[];
}

export type SubmitRequest = ReviewComment[];

export interface SubmitResponse {
	success: boolean;
	comments: number;
	error?: string;
}

export function parseContextRequest(searchParams: URLSearchParams): ContextRequest {
	const file = String(searchParams.get(CONTEXT_QUERY_KEYS.file) || "");
	const oldStart = Number(searchParams.get(CONTEXT_QUERY_KEYS.oldStart) || "0");
	const oldEnd = Number(searchParams.get(CONTEXT_QUERY_KEYS.oldEnd) || "0");
	const newStart = Number(searchParams.get(CONTEXT_QUERY_KEYS.newStart) || "0");
	const newEnd = Number(searchParams.get(CONTEXT_QUERY_KEYS.newEnd) || "0");

	return { file, oldStart, oldEnd, newStart, newEnd };
}

export function parseSubmitRequestBody(body: string): SubmitRequest {
	const parsed = JSON.parse(body) as unknown;
	if (!Array.isArray(parsed)) throw new Error("Expected an array of comments");
	return normalizeReviewComments(parsed);
}

export function createContextResponse(rows: ContextRow[]): ContextResponse {
	return { rows };
}

export function createSubmitResponse(comments: ReviewComment[]): SubmitResponse {
	return { success: true, comments: comments.length };
}

export function createSubmitErrorResponse(error: string): SubmitResponse {
	return { success: false, comments: 0, error };
}
