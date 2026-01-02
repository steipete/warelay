import type { AgentTool, AgentToolResult } from "@mariozechner/pi-ai";
import { codingTools, readTool } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { detectMime } from "../media/mime.js";
import { startWebLoginWithQr, waitForWebLogin } from "../web/login-qr.js";
import {
  type BashToolDefaults,
  createBashTool,
  createProcessTool,
  type ProcessToolDefaults,
} from "./bash-tools.js";
import { createClawdisTools } from "./clawdis-tools.js";
import { sanitizeToolResultImages } from "./tool-images.js";

// TODO(steipete): Remove this wrapper once pi-mono ships file-magic MIME detection
// for `read` image payloads in `@mariozechner/pi-coding-agent` (then switch back to `codingTools` directly).
type ToolContentBlock = AgentToolResult<unknown>["content"][number];
type ImageContentBlock = Extract<ToolContentBlock, { type: "image" }>;
type TextContentBlock = Extract<ToolContentBlock, { type: "text" }>;

async function sniffMimeFromBase64(
  base64: string,
): Promise<string | undefined> {
  const trimmed = base64.trim();
  if (!trimmed) return undefined;

  const take = Math.min(256, trimmed.length);
  const sliceLen = take - (take % 4);
  if (sliceLen < 8) return undefined;

  try {
    const head = Buffer.from(trimmed.slice(0, sliceLen), "base64");
    return await detectMime({ buffer: head });
  } catch {
    return undefined;
  }
}

function rewriteReadImageHeader(text: string, mimeType: string): string {
  // pi-coding-agent uses: "Read image file [image/png]"
  if (text.startsWith("Read image file [") && text.endsWith("]")) {
    return `Read image file [${mimeType}]`;
  }
  return text;
}

async function normalizeReadImageResult(
  result: AgentToolResult<unknown>,
  filePath: string,
): Promise<AgentToolResult<unknown>> {
  const content = Array.isArray(result.content) ? result.content : [];

  const image = content.find(
    (b): b is ImageContentBlock =>
      !!b &&
      typeof b === "object" &&
      (b as { type?: unknown }).type === "image" &&
      typeof (b as { data?: unknown }).data === "string" &&
      typeof (b as { mimeType?: unknown }).mimeType === "string",
  );
  if (!image) return result;

  if (!image.data.trim()) {
    throw new Error(`read: image payload is empty (${filePath})`);
  }

  const sniffed = await sniffMimeFromBase64(image.data);
  if (!sniffed) return result;

  if (!sniffed.startsWith("image/")) {
    throw new Error(
      `read: file looks like ${sniffed} but was treated as ${image.mimeType} (${filePath})`,
    );
  }

  if (sniffed === image.mimeType) return result;

  const nextContent = content.map((block) => {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "image"
    ) {
      const b = block as ImageContentBlock & { mimeType: string };
      return { ...b, mimeType: sniffed } satisfies ImageContentBlock;
    }
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      const b = block as TextContentBlock & { text: string };
      return {
        ...b,
        text: rewriteReadImageHeader(b.text, sniffed),
      } satisfies TextContentBlock;
    }
    return block;
  });

  return { ...result, content: nextContent };
}

// biome-ignore lint/suspicious/noExplicitAny: TypeBox schema type from pi-ai uses a different module instance.
type AnyAgentTool = AgentTool<any, unknown>;

function extractEnumValues(schema: unknown): unknown[] | undefined {
  if (!schema || typeof schema !== "object") return undefined;
  const record = schema as Record<string, unknown>;
  if (Array.isArray(record.enum)) return record.enum;
  if ("const" in record) return [record.const];
  return undefined;
}

function mergePropertySchemas(existing: unknown, incoming: unknown): unknown {
  if (!existing) return incoming;
  if (!incoming) return existing;

  const existingEnum = extractEnumValues(existing);
  const incomingEnum = extractEnumValues(incoming);
  if (existingEnum || incomingEnum) {
    const values = Array.from(
      new Set([...(existingEnum ?? []), ...(incomingEnum ?? [])]),
    );
    const merged: Record<string, unknown> = {};
    for (const source of [existing, incoming]) {
      if (!source || typeof source !== "object") continue;
      const record = source as Record<string, unknown>;
      for (const key of ["title", "description", "default"]) {
        if (!(key in merged) && key in record) merged[key] = record[key];
      }
    }
    const types = new Set(values.map((value) => typeof value));
    if (types.size === 1) merged.type = Array.from(types)[0];
    merged.enum = values;
    return merged;
  }

  return existing;
}

function normalizeToolParameters(
  tool: AnyAgentTool,
  options?: { stripAnyOf?: boolean },
): AnyAgentTool {
  const schema =
    tool.parameters && typeof tool.parameters === "object"
      ? (tool.parameters as Record<string, unknown>)
      : undefined;
  if (!schema) return tool;
  const stripAnyOf = options?.stripAnyOf === true;
  if ("type" in schema && "properties" in schema) {
    if (!stripAnyOf || !("anyOf" in schema)) return tool;
    const { anyOf: _anyOf, ...rest } = schema;
    return { ...tool, parameters: rest };
  }
  if (!Array.isArray(schema.anyOf)) {
    if (!stripAnyOf || !("anyOf" in schema)) return tool;
    const { anyOf: _anyOf, ...rest } = schema;
    return { ...tool, parameters: rest };
  }
  const mergedProperties: Record<string, unknown> = {};
  const requiredCounts = new Map<string, number>();
  let objectVariants = 0;

  for (const entry of schema.anyOf) {
    if (!entry || typeof entry !== "object") continue;
    const props = (entry as { properties?: unknown }).properties;
    if (!props || typeof props !== "object") continue;
    objectVariants += 1;
    for (const [key, value] of Object.entries(
      props as Record<string, unknown>,
    )) {
      if (!(key in mergedProperties)) {
        mergedProperties[key] = value;
        continue;
      }
      mergedProperties[key] = mergePropertySchemas(
        mergedProperties[key],
        value,
      );
    }
    const required = Array.isArray((entry as { required?: unknown }).required)
      ? (entry as { required: unknown[] }).required
      : [];
    for (const key of required) {
      if (typeof key !== "string") continue;
      requiredCounts.set(key, (requiredCounts.get(key) ?? 0) + 1);
    }
  }

  const baseRequired = Array.isArray(schema.required)
    ? schema.required.filter((key) => typeof key === "string")
    : undefined;
  const mergedRequired =
    baseRequired && baseRequired.length > 0
      ? baseRequired
      : objectVariants > 0
        ? Array.from(requiredCounts.entries())
            .filter(([, count]) => count === objectVariants)
            .map(([key]) => key)
        : undefined;

  const { anyOf: _anyOf, ...rest } = schema;
  const base = stripAnyOf ? rest : schema;
  return {
    ...tool,
    parameters: {
      ...base,
      type: "object",
      properties:
        Object.keys(mergedProperties).length > 0
          ? mergedProperties
          : (schema.properties ?? {}),
      ...(mergedRequired && mergedRequired.length > 0
        ? { required: mergedRequired }
        : {}),
      additionalProperties:
        "additionalProperties" in schema ? schema.additionalProperties : true,
    },
  };
}

function sanitizeSchemaForGoogle(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map((item) => sanitizeSchemaForGoogle(item));
  }
  if (!schema || typeof schema !== "object") return schema;

  const record = schema as Record<string, unknown>;
  const next: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(record)) {
    if (key === "const" || key === "patternProperties") continue;
    next[key] = sanitizeSchemaForGoogle(value);
  }

  if ("const" in record) {
    const constValue = record.const;
    const existingEnum = Array.isArray(next.enum) ? next.enum : [];
    if (!existingEnum.some((value) => value === constValue)) {
      next.enum = [...existingEnum, constValue];
    } else if (existingEnum.length > 0) {
      next.enum = existingEnum;
    }
  }

  if ("patternProperties" in record) {
    const patternProps = record.patternProperties;
    if (patternProps && typeof patternProps === "object") {
      const entries = Object.entries(
        patternProps as Record<string, unknown>,
      );
      if (entries.length === 1) {
        const [, patternSchema] = entries[0];
        if (next.additionalProperties === undefined) {
          next.additionalProperties = sanitizeSchemaForGoogle(patternSchema);
        }
      } else if (entries.length > 1) {
        if (next.additionalProperties === undefined) {
          next.additionalProperties = true;
        }
      }
    }
  }

  return next;
}

function sanitizeToolParametersForGoogle(tool: AnyAgentTool): AnyAgentTool {
  const schema =
    tool.parameters && typeof tool.parameters === "object"
      ? (tool.parameters as Record<string, unknown>)
      : undefined;
  if (!schema) return tool;
  return {
    ...tool,
    parameters: sanitizeSchemaForGoogle(schema),
  };
}

function createWhatsAppLoginTool(): AnyAgentTool {
  return {
    label: "WhatsApp Login",
    name: "whatsapp_login",
    description:
      "Generate a WhatsApp QR code for linking, or wait for the scan to complete.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("start"), Type.Literal("wait")]),
      timeoutMs: Type.Optional(Type.Number()),
      force: Type.Optional(Type.Boolean()),
    }),
    execute: async (_toolCallId, args) => {
      const action = (args as { action?: string })?.action ?? "start";
      if (action === "wait") {
        const result = await waitForWebLogin({
          timeoutMs:
            typeof (args as { timeoutMs?: unknown }).timeoutMs === "number"
              ? (args as { timeoutMs?: number }).timeoutMs
              : undefined,
        });
        return {
          content: [{ type: "text", text: result.message }],
          details: { connected: result.connected },
        };
      }

      const result = await startWebLoginWithQr({
        timeoutMs:
          typeof (args as { timeoutMs?: unknown }).timeoutMs === "number"
            ? (args as { timeoutMs?: number }).timeoutMs
            : undefined,
        force:
          typeof (args as { force?: unknown }).force === "boolean"
            ? (args as { force?: boolean }).force
            : false,
      });

      if (!result.qrDataUrl) {
        return {
          content: [
            {
              type: "text",
              text: result.message,
            },
          ],
          details: { qr: false },
        };
      }

      const text = [
        result.message,
        "",
        "Open WhatsApp → Linked Devices and scan:",
        "",
        `![whatsapp-qr](${result.qrDataUrl})`,
      ].join("\n");
      return {
        content: [{ type: "text", text }],
        details: { qr: true },
      };
    },
  };
}

function createClawdisReadTool(base: AnyAgentTool): AnyAgentTool {
  return {
    ...base,
    execute: async (toolCallId, params, signal) => {
      const result = (await base.execute(
        toolCallId,
        params,
        signal,
      )) as AgentToolResult<unknown>;
      const record =
        params && typeof params === "object"
          ? (params as Record<string, unknown>)
          : undefined;
      const filePath =
        typeof record?.path === "string" ? String(record.path) : "<unknown>";
      const normalized = await normalizeReadImageResult(result, filePath);
      return sanitizeToolResultImages(normalized, `read:${filePath}`);
    },
  };
}

export function createClawdisCodingTools(options?: {
  bash?: BashToolDefaults & ProcessToolDefaults;
  stripAnyOf?: boolean;
  sanitizeForGoogle?: boolean;
}): AnyAgentTool[] {
  const bashToolName = "bash";
  const base = (codingTools as unknown as AnyAgentTool[]).flatMap((tool) => {
    if (tool.name === readTool.name) return [createClawdisReadTool(tool)];
    if (tool.name === bashToolName) return [];
    return [tool as AnyAgentTool];
  });
  const bashTool = createBashTool(options?.bash);
  const processTool = createProcessTool({
    cleanupMs: options?.bash?.cleanupMs,
  });
  const tools: AnyAgentTool[] = [
    ...base,
    bashTool as unknown as AnyAgentTool,
    processTool as unknown as AnyAgentTool,
    createWhatsAppLoginTool(),
    ...createClawdisTools(),
  ];
  return tools.map((tool) => {
    let next = normalizeToolParameters(tool, {
      stripAnyOf: options?.stripAnyOf,
    });
    if (options?.sanitizeForGoogle) {
      next = sanitizeToolParametersForGoogle(next);
    }
    return next;
  });
}
