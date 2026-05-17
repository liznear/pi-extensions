import { complete } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  AgentEndEvent,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  convertToLlm,
  serializeConversation,
} from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";

const DETECTION_SYSTEM_PROMPT = `You analyze whether a user message is a correction to the AI assistant's previous behavior or output.

A correction is when the user:
- Points out something the AI did wrong or suboptimally
- Tells the AI to do something differently than what it did
- Provides feedback that the AI's approach/output was incorrect
- Asks the AI to fix or redo something because the first attempt was wrong
- Clarifies requirements that the AI misunderstood

It is NOT a correction if the user is:
- Asking a new question
- Providing new instructions for a new task
- Simply continuing the conversation
- Giving positive feedback

Use the report_analysis tool to report your findings.`;

const analysisTool = {
  name: "report_analysis",
  description:
    "Report whether the user message is a correction and, if so, extract a learning",
  parameters: Type.Object({
    isCorrection: Type.Boolean({
      description: "Whether the latest user message is a correction",
    }),
    reason: Type.String({
      description: "Brief explanation of why this is or isn't a correction",
    }),
    learning: Type.Optional(
      Type.String({
        description:
          "If this is a correction, a clear actionable rule/guideline (written as instructions for an AI coding agent) to prevent this mistake in the future",
      }),
    ),
  }),
};

interface AnalysisResult {
  isCorrection: boolean;
  reason: string;
  learning?: string;
}

function extractLastUserText(event: AgentEndEvent): string | undefined {
  const messages = event.messages;
  if (!messages || messages.length === 0) return undefined;

  const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUserMsg) return undefined;

  const content =
    typeof lastUserMsg.content === "string"
      ? lastUserMsg.content
      : lastUserMsg.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join("\n");

  return content.trim() || undefined;
}

async function detectCorrection(
  ctx: ExtensionContext,
  conversationText: string,
  userText: string,
): Promise<AnalysisResult | undefined> {
  const model = ctx.model;

  if (!model) return undefined;

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) return undefined;

  // Truncate conversation to avoid huge payloads
  const maxChars = 15000;
  const truncatedConv =
    conversationText.length > maxChars
      ? conversationText.slice(-maxChars)
      : conversationText;

  const response = await complete(
    model,
    {
      systemPrompt: DETECTION_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `<conversation>\n${truncatedConv}\n</conversation>\n\nLatest user message:\n${userText}`,
            },
          ],
          timestamp: Date.now(),
        },
      ],
      tools: [analysisTool],
    },
    {
      apiKey: auth.apiKey,
      headers: auth.headers,
      maxTokens: 1024,
      signal: ctx.signal,
    },
  );

  // Extract the tool call from the response
  const toolCall = response.content.find(
    (c) => c.type === "toolCall" && c.name === "report_analysis",
  );
  if (!toolCall || toolCall.type !== "toolCall") return undefined;

  return {
    isCorrection: !!toolCall.arguments.isCorrection,
    reason: String(toolCall.arguments.reason ?? ""),
    learning: toolCall.arguments.learning
      ? String(toolCall.arguments.learning)
      : undefined,
  };
}

function appendLearningToAgentsMd(cwd: string, learning: string): boolean {
  const agentsMdPath = join(cwd, "AGENTS.md");
  if (!existsSync(agentsMdPath)) return false;

  const existing = readFileSync(agentsMdPath, "utf8");
  const sectionHeader = "## Auto-Learnings";

  let updated: string;
  if (existing.includes(sectionHeader)) {
    updated = existing.replace(
      sectionHeader,
      `${sectionHeader}\n- ${learning}`,
    );
  } else {
    updated = `${existing.trimEnd()}\n\n${sectionHeader}\n- ${learning}\n`;
  }

  writeFileSync(agentsMdPath, updated, "utf8");
  return true;
}

export default function (pi: ExtensionAPI) {
  pi.on("agent_end", async (event, ctx) => {
    try {
      const userText = extractLastUserText(event);
      if (!userText) return;

      const conversationText = serializeConversation(
        convertToLlm(event.messages),
      );
      const result = await detectCorrection(ctx, conversationText, userText);
      if (!result?.isCorrection || !result.learning) return;

      const updated = appendLearningToAgentsMd(ctx.cwd, result.learning);
      if (updated && ctx.hasUI) {
        ctx.ui.notify(`Auto-correction: added learning to AGENTS.md`, "info");
      }
    } catch {
      // Silently ignore errors - this is best-effort
    }
  });
}
