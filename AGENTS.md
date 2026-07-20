# Agents

## Context-Driven Execution (The Context Layer)

To prevent guessing and reduce blind code searching, this project uses a explicit `.context/` layer.

**The Golden Rule of Balance:**

- **Code is for "HOW" and "WHAT IS":** Use code search (`rg`, `symbol_search`, LSP) to find syntax, exact implementation details, and trace deterministic call graphs.
- **Context is for "WHY", "WHERE", and "WHAT IT MEANS":** Use the `.context/` layer for business definitions, implicit rules, architectural boundaries, and starting points.

**The Workflow:**

1. **Query:** Before starting a complex task, check `.context/` for relevant terms or routing.
2. **Read Code:** If the context tells you *where* to look (e.g., `routing/auth.md`), go read those specific code files.
3. **Ask & Pause:** If you encounter a business concept you don't understand, or code logic that implies an undocumented rule, **DO NOT GUESS**. Use the `ask_user` tool to explicitly ask for the context.
4. **Persist:** When the user answers your context question, you MUST write that answer into the `.context/` directory (e.g., `.context/terms/new-concept.md`) before continuing, so future agents won't have to ask.

## Auto-Learnings

- When a tool fails due to a disabled feature and you advise the user how to enable it, if the user repeats the same request, assume they have already taken the corrective action and retry immediately. Do not re-explain the same obstacle or ask permission again — just attempt the task again from the start.
- When a user repeats the same question verbatim after you've provided an answer, don't just repeat or elaborate on the same analysis. Re-examine the problem more carefully — the user is signaling that your previous response was insufficient. Investigate whether your recent changes may have introduced or failed to fix the errors, rather than assuming they are pre-existing. Also check if there are other sources of errors (e.g., biome, TypeScript strict mode, unresolved imports from your edits) that you may have overlooked.
- When the user asks to "run lint and fix the errors," address ALL errors reported in the output, including LSP/TypeScript type errors — don't dismiss any category of errors as "pre-existing" unless explicitly told to. The user's definition of "errors" includes everything shown in the diagnostic output.
- Always verify that URLs exist and are correct before recommending them to the user. Use fetch_content or web_search to confirm a link is valid before including it in any response. Do not assume or guess at domain names.
