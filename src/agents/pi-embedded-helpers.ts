import fs from "node:fs/promises";
import path from "node:path";

import type { AppMessage } from "@mariozechner/pi-agent-core";
import type { AgentToolResult, AssistantMessage } from "@mariozechner/pi-ai";

import { sanitizeContentBlocksImages } from "./tool-images.js";
import type { WorkspaceBootstrapFile } from "./workspace.js";

export type EmbeddedContextFile = { path: string; content: string };

export async function ensureSessionHeader(params: {
  sessionFile: string;
  sessionId: string;
  cwd: string;
}) {
  const file = params.sessionFile;
  try {
    await fs.stat(file);
    return;
  } catch {
    // create
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  const sessionVersion = 2;
  const entry = {
    type: "session",
    version: sessionVersion,
    id: params.sessionId,
    timestamp: new Date().toISOString(),
    cwd: params.cwd,
  };
  await fs.writeFile(file, `${JSON.stringify(entry)}\n`, "utf-8");
}

type ContentBlock = AgentToolResult<unknown>["content"][number];

export async function sanitizeSessionMessagesImages(
  messages: AppMessage[],
  label: string,
): Promise<AppMessage[]> {
  // We sanitize historical session messages because Anthropic can reject a request
  // if the transcript contains oversized base64 images (see MAX_IMAGE_DIMENSION_PX).
  const out: AppMessage[] = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      out.push(msg);
      continue;
    }

    const role = (msg as { role?: unknown }).role;
    if (role === "toolResult") {
      const toolMsg = msg as Extract<AppMessage, { role: "toolResult" }>;
      const content = Array.isArray(toolMsg.content) ? toolMsg.content : [];
      const nextContent = (await sanitizeContentBlocksImages(
        content as ContentBlock[],
        label,
      )) as unknown as typeof toolMsg.content;
      out.push({ ...toolMsg, content: nextContent });
      continue;
    }

    if (role === "user") {
      const userMsg = msg as Extract<AppMessage, { role: "user" }>;
      const content = userMsg.content;
      if (Array.isArray(content)) {
        const nextContent = (await sanitizeContentBlocksImages(
          content as unknown as ContentBlock[],
          label,
        )) as unknown as typeof userMsg.content;
        out.push({ ...userMsg, content: nextContent });
        continue;
      }
    }

    out.push(msg);
  }
  return out;
}

export function sanitizeSessionMessagesForGoogle(
  messages: AppMessage[],
): AppMessage[] {
  type AssistantContentBlock =
    Extract<AppMessage, { role: "assistant" }>["content"][number];
  type AssistantToolCall = Extract<AssistantContentBlock, { type: "toolCall" }>;
  const out: AppMessage[] = [];
  const skippedToolCalls = new Set<string>();
  let lastRole: string | undefined;
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      out.push(msg);
      continue;
    }
    const role = (msg as { role?: unknown }).role;
    if (role === "toolResult") {
      const toolResult = msg as Extract<AppMessage, { role: "toolResult" }>;
      const toolCallId =
        typeof (toolResult as { toolCallId?: unknown }).toolCallId === "string"
          ? (toolResult as { toolCallId: string }).toolCallId
          : undefined;
      if (toolCallId && skippedToolCalls.has(toolCallId)) {
        continue;
      }
      out.push(toolResult);
      lastRole = "toolResult";
      continue;
    }

    if (role !== "assistant") {
      out.push(msg);
      lastRole = typeof role === "string" ? role : lastRole;
      continue;
    }

    const assistantMsg = msg as Extract<AppMessage, { role: "assistant" }>;
    const content = (assistantMsg as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      out.push(msg);
      lastRole = "assistant";
      continue;
    }
    const toolOnly = content.filter(
      (block): block is AssistantToolCall =>
        block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "toolCall",
    );
    const hasToolCall = toolOnly.length > 0;

    if (!hasToolCall) {
      out.push(msg);
      lastRole = "assistant";
      continue;
    }

    if (lastRole !== "user" && lastRole !== "toolResult") {
      for (const block of toolOnly) {
        if (typeof block.id === "string") {
          skippedToolCalls.add(block.id);
        }
      }
      continue;
    }

    out.push({ ...assistantMsg, content: toolOnly });
    lastRole = "assistant";
  }
  return out;
}

export function buildBootstrapContextFiles(
  files: WorkspaceBootstrapFile[],
): EmbeddedContextFile[] {
  return files.map((file) => ({
    path: file.name,
    content: file.missing
      ? `[MISSING] Expected at: ${file.path}`
      : (file.content ?? ""),
  }));
}

export function formatAssistantErrorText(
  msg: AssistantMessage,
): string | undefined {
  if (msg.stopReason !== "error") return undefined;
  const raw = (msg.errorMessage ?? "").trim();
  if (!raw) return "LLM request failed with an unknown error.";

  const invalidRequest = raw.match(
    /"type":"invalid_request_error".*?"message":"([^"]+)"/,
  );
  if (invalidRequest?.[1]) {
    return `LLM request rejected: ${invalidRequest[1]}`;
  }

  // Keep it short for WhatsApp.
  return raw.length > 600 ? `${raw.slice(0, 600)}…` : raw;
}
