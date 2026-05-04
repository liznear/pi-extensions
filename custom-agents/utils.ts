import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export type AgentType = "primary" | "subagent";

export type AgentProfile = {
	name: string;
	type: AgentType;
	allowedTools?: string[];
	systemPromptTemplate: string;
	sourcePath: string;
};

function parseInlineList(value: string): string[] {
	const trimmed = value.trim();
	if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return [];
	return trimmed
		.slice(1, -1)
		.split(",")
		.map((v) => v.trim().replace(/^['\"]|['\"]$/g, ""))
		.filter(Boolean);
}

function parseFrontmatter(markdown: string): { frontmatter: Record<string, unknown>; body: string } {
	if (!markdown.startsWith("---\n")) {
		return { frontmatter: {}, body: markdown };
	}

	const endIndex = markdown.indexOf("\n---\n", 4);
	if (endIndex === -1) {
		return { frontmatter: {}, body: markdown };
	}

	const raw = markdown.slice(4, endIndex);
	const body = markdown.slice(endIndex + 5);
	const lines = raw.split("\n");
	const frontmatter: Record<string, unknown> = {};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line.includes(":")) continue;
		const [keyRaw, ...rest] = line.split(":");
		const key = keyRaw.trim();
		const value = rest.join(":").trim();

		if (key === "allowed_tools") {
			if (value === "") {
				const items: string[] = [];
				let j = i + 1;
				for (; j < lines.length; j++) {
					const next = lines[j].trim();
					if (!next.startsWith("- ")) break;
					items.push(next.slice(2).trim().replace(/^['\"]|['\"]$/g, ""));
				}
				frontmatter.allowed_tools = items;
				i = j - 1;
			} else {
				const inline = parseInlineList(value);
				frontmatter.allowed_tools = inline.length ? inline : [value.replace(/^['\"]|['\"]$/g, "")];
			}
			continue;
		}

		frontmatter[key] = value.replace(/^['\"]|['\"]$/g, "");
	}

	return { frontmatter, body };
}

export async function loadAgentProfiles(agentsDir: string): Promise<{ profiles: AgentProfile[]; errors: string[] }> {
	const errors: string[] = [];
	const profiles: AgentProfile[] = [];

	let files: string[] = [];
	try {
		files = await readdir(agentsDir);
	} catch {
		return { profiles: [], errors: [] };
	}

	for (const file of files.filter((f) => f.endsWith(".md")).sort()) {
		const path = join(agentsDir, file);
		try {
			const markdown = await readFile(path, "utf8");
			const { frontmatter, body } = parseFrontmatter(markdown);
			const name = String(frontmatter.name ?? "").trim();
			if (!name) {
				errors.push(`${file}: missing required frontmatter field 'name'`);
				continue;
			}

			const typeRaw = String(frontmatter.type ?? "subagent").trim();
			const type: AgentType = typeRaw === "primary" ? "primary" : "subagent";
			const allowedTools = Array.isArray(frontmatter.allowed_tools)
				? (frontmatter.allowed_tools as string[]).map((t) => String(t).trim()).filter(Boolean)
				: undefined;

			profiles.push({
				name,
				type,
				allowedTools: allowedTools && allowedTools.length > 0 ? allowedTools : undefined,
				systemPromptTemplate: body.trim(),
				sourcePath: path,
			});
		} catch (error) {
			errors.push(`${file}: ${(error as Error).message}`);
		}
	}

	const seen = new Set<string>();
	for (const p of profiles) {
		if (seen.has(p.name)) {
			errors.push(`Duplicate agent name: '${p.name}'`);
		}
		seen.add(p.name);
	}

	return { profiles, errors };
}
