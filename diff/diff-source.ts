import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { ContextRow } from "./web-review-types.js";

const run = promisify(execFile);

export async function resolveGitTarget(cwd: string, target = "HEAD"): Promise<string | null> {
	const normalizedTarget = target.trim() || "HEAD";
	try {
		return (await run("git", ["rev-parse", "--verify", "--short=8", `${normalizedTarget}^{commit}`], { cwd, maxBuffer: 1024 * 1024 })).stdout.trim();
	} catch {
		return null;
	}
}

export async function getGitDiff(cwd: string, target = "HEAD"): Promise<string> {
	const normalizedTarget = target.trim() || "HEAD";
	try {
		return (await run("git", ["diff", normalizedTarget], { cwd, maxBuffer: 10 * 1024 * 1024 })).stdout;
	} catch {
		return "";
	}
}

export async function loadGapContext(input: {
	cwd: string;
	target: string;
	file: string;
	oldStart: number;
	oldEnd: number;
	newStart: number;
	newEnd: number;
}): Promise<ContextRow[]> {
	if (!input.file) throw new Error("Missing file");

	const oldLines = await readFileAtTarget(input.cwd, input.target, input.file);
	const newLines = await readWorkingTreeFile(input.cwd, input.file);

	const oldRange = extractLineRange(oldLines, input.oldStart, input.oldEnd);
	const newRange = extractLineRange(newLines, input.newStart, input.newEnd);

	const rows: ContextRow[] = [];
	const maxLen = Math.max(oldRange.length, newRange.length);
	for (let i = 0; i < maxLen; i++) {
		const oldItem = oldRange[i];
		const newItem = newRange[i];
		rows.push({
			oldLine: oldItem?.line,
			oldContent: oldItem?.content,
			newLine: newItem?.line,
			newContent: newItem?.content,
		});
	}

	return rows;
}

async function readFileAtTarget(cwd: string, target: string, file: string): Promise<string[] | null> {
	try {
		const out = await run("git", ["show", `${target}:${file}`], { cwd, maxBuffer: 5 * 1024 * 1024 });
		return splitLines(out.stdout);
	} catch {
		return null;
	}
}

async function readWorkingTreeFile(cwd: string, file: string): Promise<string[] | null> {
	const root = path.resolve(cwd);
	const abs = path.resolve(root, file);
	if (!(abs === root || abs.startsWith(root + path.sep))) return null;
	try {
		const text = await readFile(abs, "utf8");
		return splitLines(text);
	} catch {
		return null;
	}
}

function splitLines(text: string): string[] {
	const lines = text.replace(/\r/g, "").split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

function extractLineRange(lines: string[] | null, start: number, end: number): Array<{ line: number; content: string }> {
	if (!lines || !Number.isFinite(start) || !Number.isFinite(end) || end < start || end < 1) return [];

	const clampedStart = Math.max(1, start);
	const clampedEnd = Math.min(lines.length, end);
	if (clampedEnd < clampedStart) return [];

	const out: Array<{ line: number; content: string }> = [];
	for (let lineNo = clampedStart; lineNo <= clampedEnd; lineNo++) {
		out.push({ line: lineNo, content: lines[lineNo - 1] ?? "" });
	}
	return out;
}
