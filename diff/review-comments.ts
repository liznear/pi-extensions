import type { ReviewComment } from "./web-review-types.js";

function normalizeReviewComment(input: unknown): ReviewComment | null {
	if (!input || typeof input !== "object") return null;

	const item = input as Record<string, unknown>;
	const file = String(item.file ?? "").trim();
	const line = String(item.line ?? "").trim();
	const side = item.side;
	const comment = String(item.comment ?? "").trim();

	if (!file || !line || !comment) return null;
	if (side !== "old" && side !== "new") return null;

	return { file, line, side, comment };
}

export function normalizeReviewComments(input: unknown): ReviewComment[] {
	if (!Array.isArray(input)) return [];

	const comments: ReviewComment[] = [];
	for (const item of input) {
		const normalized = normalizeReviewComment(item);
		if (normalized) comments.push(normalized);
	}
	return comments;
}

export function renderSteeringPrompt(comments: ReviewComment[]): string {
	const lines = comments.map((comment) =>
		`- **${comment.file}:${comment.side}:${comment.line}**: ${comment.comment}`,
	);

	return [
		"I have reviewed the local changes. Please address the following comments:",
		"",
		...lines,
	].join("\n");
}
