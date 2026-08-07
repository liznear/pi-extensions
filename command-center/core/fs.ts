import { access } from "node:fs/promises"

/**
 * True iff `path` exists (any type). Never throws — swallows `access` errors
 * (ENOENT, permission, …) and returns false.
 *
 * Runtime-neutral (`node:fs`) so it runs under both Bun (`bun test`) and Node
 * (Electron main). See runtime map ticket 02.
 */
export async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path)
		return true
	} catch {
		return false
	}
}
