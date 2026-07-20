---
name: context-layer
description: "Progressive Context Layer rules. Use to query, ask, and persist project business logic, intent, and routing instead of blind guessing or excessive code searching."
---

# Context Layer Strategy

This project uses a progressive Context Layer to eliminate AI guessing and codebase blind-searching.

**The Golden Rule of Balance:**

- **Code is for "HOW" and "WHAT IS":** Use code search (`rg`, `symbol_search`, LSP) to find syntax, exact implementation details, and trace deterministic call graphs.
- **Context is for "WHY", "WHERE", and "WHAT IT MEANS":** Use the `.context/` layer for business definitions, implicit rules, architectural boundaries, and starting points.

**The Workflow (MANDATORY):**

1. **Query FIRST:** Before starting a complex task, you MUST check `.context/` using the custom `query_context` tool for relevant terms or routing.
2. **Read Code:** If the context tells you *where* to look (e.g., `routing/auth.md`), go read those specific code files.
3. **Ask & Pause:** If you encounter a business concept you don't understand, or code logic that implies an undocumented rule, **DO NOT GUESS**. You MUST use the custom `ask_for_context` tool to explicitly ask the human. Do NOT use the default `ask_user` tool for business context questions.
4. **Persist IMMEDIATELY:** When the human answers your context question via `ask_for_context`, your VERY NEXT ACTION MUST BE to use the `persist_context` tool to write that answer into the `.context/` directory. Do not write code until you have persisted the context.
