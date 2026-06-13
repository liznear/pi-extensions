import type { RenderedFile, RenderedHunk } from "./web-review-types.js"

export function parseUnifiedDiff(raw: string): RenderedFile[] {
	const files: RenderedFile[] = []
	let currentFile: RenderedFile | null = null
	let currentHunk: RenderedHunk | null = null
	let oldLine = 0
	let newLine = 0

	for (const line of raw.split("\n")) {
		if (line.startsWith("diff --git ")) {
			currentFile = { path: parseDiffPath(line), hunks: [] }
			files.push(currentFile)
			currentHunk = null
			continue
		}

		if (!currentFile) continue

		if (line.startsWith("+++ ")) {
			const match = line.match(/^\+\+\+\s+([^/]+)\/(.+)$/)
			if (match) currentFile.path = match[2]
			continue
		}

		const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/)
		if (hunk) {
			const oldStart = Number(hunk[1])
			const oldCount = Number(hunk[2] || "1")
			const newStart = Number(hunk[3])
			const newCount = Number(hunk[4] || "1")
			currentHunk = {
				header: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${hunk[5] || ""}`,
				oldStart,
				oldCount,
				newStart,
				newCount,
				lines: [],
			}
			currentFile.hunks.push(currentHunk)
			oldLine = oldStart
			newLine = newStart
			continue
		}

		if (!currentHunk || line.startsWith("\\ No newline")) continue

		if (line.startsWith("+")) {
			currentHunk.lines.push({ type: "added", newLine, content: line.slice(1) })
			newLine++
		} else if (line.startsWith("-")) {
			currentHunk.lines.push({
				type: "removed",
				oldLine,
				content: line.slice(1),
			})
			oldLine++
		} else if (line.startsWith(" ")) {
			currentHunk.lines.push({
				type: "context",
				oldLine,
				newLine,
				content: line.slice(1),
			})
			oldLine++
			newLine++
		}
	}

	return files.filter((file) =>
		file.hunks.some((hunk) => hunk.lines.length > 0),
	)
}

function parseDiffPath(line: string): string {
	const parts = line.split(" ")
	const right = parts[parts.length - 1] || ""
	const prefixed = right.match(/^[a-z]\/(.+)$/)
	return prefixed ? prefixed[1] : right
}
