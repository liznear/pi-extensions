# Context Layer: Agent Protocol & Storage Interface

## The Problem

Agents often guess or blindly search codebase for implicit business logic. Building a "Context Layer" (Company Brain) upfront is hard due to the cold-start problem: humans don't know what context the agent will need until it fails.

## The Solution: Iterative Context Discovery

Instead of pre-building the context layer, we let the agent **explicitly request** what it needs when it encounters an information gap. If the context doesn't exist, it asks the human. Once the human provides it, the agent **writes it back** to the context layer so future agents don't have to ask again.

## Core Interaction Loop

1. **Agent gets task.**
2. **Agent queries Context Layer** for relevant terms/rules.
3. **Context missing/ambiguous?** Agent triggers `request_context(gap_description)`.
4. **Human provides answer** (direct definition or points to a file/doc).
5. **Agent persists the learning** by writing the structured context back to the Context Layer.
6. **Agent continues** execution.

## Context Layer Structure (Proposal)

We need a structured, machine-readable storage layer that the agent can efficiently query and update.

### Storage Format

A semantic hierarchy, likely a directory of Markdown/JSON/YAML files, or an SQLite database. A file-based approach (e.g., `.context/`) is often easiest for humans to review and version control alongside code.

#### Example Directory Structure

```text
.context/
├── glossary/          # Definitions of business terms (e.g., ARR, Drive-thru time)
├── architectures/     # System boundaries, dependencies, design patterns
├── conventions/       # Code style, error handling, review guidelines
├── routing/           # "Where to find X" (e.g., "Auth logic is in /src/auth")
└── index.json         # Searchable index/metadata for quick agent lookup
```

### Required Agent Interfaces (Tools)

To make this work, the agent needs specific tools to read/write this layer:

#### 1. `query_context(query: string)`

* **Purpose:** Agent uses this to ask the layer about a concept before guessing.
* **Behavior:** Performs semantic/keyword search over the `.context/` directory.

#### 2. `request_human_context(gap: string, context_type: "glossary" | "architecture" | "convention")`

* **Purpose:** Explicitly stop execution and prompt the human when `query_context` yields no results or conflicting results.
* **Behavior:** Pauses execution. Prompts the human with the specific gap.

#### 3. `save_context(category: string, key: string, content: string)`

* **Purpose:** The critical step for iterative building. After learning something from the human (via `request_human_context`), the agent saves it permanently.
* **Behavior:** Creates or updates a file in the `.context/` directory.

## Why this works
* **Solves Cold Start:** The layer starts empty and grows organically based strictly on what the agent *actually needs*.
* **No Trace Digging:** When the agent fails, it's because it *didn't ask* or the human gave a *bad answer*. The failure point is explicit, not hidden in an opaque execution trace.
* **Context as Code (IP):** The resulting `.context/` directory becomes versionable, searchable IP for the company.
