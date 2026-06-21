# Agents

## Auto-Learnings
- When a tool fails due to a disabled feature and you advise the user how to enable it, if the user repeats the same request, assume they have already taken the corrective action and retry immediately. Do not re-explain the same obstacle or ask permission again — just attempt the task again from the start.
- When a user repeats the same question verbatim after you've provided an answer, don't just repeat or elaborate on the same analysis. Re-examine the problem more carefully — the user is signaling that your previous response was insufficient. Investigate whether your recent changes may have introduced or failed to fix the errors, rather than assuming they are pre-existing. Also check if there are other sources of errors (e.g., biome, TypeScript strict mode, unresolved imports from your edits) that you may have overlooked.
- When the user asks to "run lint and fix the errors," address ALL errors reported in the output, including LSP/TypeScript type errors — don't dismiss any category of errors as "pre-existing" unless explicitly told to. The user's definition of "errors" includes everything shown in the diagnostic output.
- Always verify that URLs exist and are correct before recommending them to the user. Use fetch_content or web_search to confirm a link is valid before including it in any response. Do not assume or guess at domain names.
