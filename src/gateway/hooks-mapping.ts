import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  CONFIG_PATH_CLAWDIS,
  type HookMappingConfig,
  type HooksConfig,
} from "../config/config.js";

export type HookMappingResolved = {
  id: string;
  matchPath?: string;
  matchSource?: string;
  action: "wake" | "agent";
  wakeMode?: "now" | "next-heartbeat";
  name?: string;
  sessionKey?: string;
  messageTemplate?: string;
  textTemplate?: string;
  deliver?: boolean;
  channel?: "last" | "whatsapp" | "telegram" | "discord" | "signal" | "imessage";
  to?: string;
  thinking?: string;
  timeoutSeconds?: number;
  transform?: HookMappingTransformResolved;
};

export type HookMappingTransformResolved = {
  modulePath: string;
  exportName?: string;
};

export type HookMappingContext = {
  payload: Record<string, unknown>;
  headers: Record<string, string>;
  url: URL;
  path: string;
};

export type HookAction =
  | {
      kind: "wake";
      text: string;
      mode: "now" | "next-heartbeat";
    }
  | {
      kind: "agent";
      message: string;
      name?: string;
      wakeMode: "now" | "next-heartbeat";
      sessionKey?: string;
      deliver?: boolean;
      channel?: "last" | "whatsapp" | "telegram" | "discord" | "signal" | "imessage";
      to?: string;
      thinking?: string;
      timeoutSeconds?: number;
    };

export type HookMappingResult =
  | { ok: true; action: HookAction }
  | { ok: false; error: string };

const hookPresetMappings: Record<string, HookMappingConfig[]> = {
  gmail: [
    {
      id: "gmail",
      match: { path: "gmail" },
      action: "agent",
      wakeMode: "now",
      name: "Gmail",
      sessionKey: "hook:gmail:{{messages[0].id}}",
      messageTemplate:
        "New email from {{messages[0].from}}\nSubject: {{messages[0].subject}}\n{{messages[0].snippet}}\n{{messages[0].body}}",
    },
  ],
};

const transformCache = new Map<string, HookTransformFn>();

type HookTransformResult = Partial<{
  kind: HookAction["kind"];
  text: string;
  mode: "now" | "next-heartbeat";
  message: string;
  wakeMode: "now" | "next-heartbeat";
  name: string;
  sessionKey: string;
  deliver: boolean;
  channel: "last" | "whatsapp" | "telegram" | "discord" | "signal" | "imessage";
  to: string;
  thinking: string;
  timeoutSeconds: number;
}> | null;

type HookTransformFn = (
  ctx: HookMappingContext,
) => HookTransformResult | Promise<HookTransformResult>;

export function resolveHookMappings(
  hooks?: HooksConfig,
): HookMappingResolved[] {
  const presets = hooks?.presets ?? [];
  const mappings: HookMappingConfig[] = [];
  for (const preset of presets) {
    const presetMappings = hookPresetMappings[preset];
    if (presetMappings) mappings.push(...presetMappings);
  }
  if (hooks?.mappings) mappings.push(...hooks.mappings);
  if (mappings.length === 0) return [];

  const configDir = path.dirname(CONFIG_PATH_CLAWDIS);
  const transformsDir = hooks?.transformsDir
    ? resolvePath(configDir, hooks.transformsDir)
    : configDir;

  return mappings.map((mapping, index) =>
    normalizeHookMapping(mapping, index, transformsDir),
  );
}

export async function applyHookMappings(
  mappings: HookMappingResolved[],
  ctx: HookMappingContext,
): Promise<HookMappingResult | null> {
  if (mappings.length === 0) return null;
  for (const mapping of mappings) {
    if (!mappingMatches(mapping, ctx)) continue;

    const base = buildActionFromMapping(mapping, ctx);
    if (!base.ok) return base;

    let override: HookTransformResult = null;
    if (mapping.transform) {
      const transform = await loadTransform(mapping.transform);
      override = await transform(ctx);
      if (override === null) return null;
    }

    const merged = mergeAction(base.action, override, mapping.action);
    if (!merged.ok) return merged;
    return merged;
  }
  return null;
}

function normalizeHookMapping(
  mapping: HookMappingConfig,
  index: number,
  transformsDir: string,
): HookMappingResolved {
  const id = mapping.id?.trim() || `mapping-${index + 1}`;
  const matchPath = normalizeMatchPath(mapping.match?.path);
  const matchSource = mapping.match?.source?.trim();
  const action = mapping.action ?? "agent";
  const wakeMode = mapping.wakeMode ?? "now";
  const transform = mapping.transform
    ? {
        modulePath: resolvePath(transformsDir, mapping.transform.module),
        exportName: mapping.transform.export?.trim() || undefined,
      }
    : undefined;

  return {
    id,
    matchPath,
    matchSource,
    action,
    wakeMode,
    name: mapping.name,
    sessionKey: mapping.sessionKey,
    messageTemplate: mapping.messageTemplate,
    textTemplate: mapping.textTemplate,
    deliver: mapping.deliver,
    channel: mapping.channel,
    to: mapping.to,
    thinking: mapping.thinking,
    timeoutSeconds: mapping.timeoutSeconds,
    transform,
  };
}

function mappingMatches(mapping: HookMappingResolved, ctx: HookMappingContext) {
  if (mapping.matchPath) {
    if (mapping.matchPath !== normalizeMatchPath(ctx.path)) return false;
  }
  if (mapping.matchSource) {
    const source =
      typeof ctx.payload.source === "string" ? ctx.payload.source : undefined;
    if (!source || source !== mapping.matchSource) return false;
  }
  return true;
}

function buildActionFromMapping(
  mapping: HookMappingResolved,
  ctx: HookMappingContext,
): HookMappingResult {
  if (mapping.action === "wake") {
    const text = renderTemplate(mapping.textTemplate ?? "", ctx);
    return {
      ok: true,
      action: {
        kind: "wake",
        text,
        mode: mapping.wakeMode ?? "now",
      },
    };
  }
  const message = renderTemplate(mapping.messageTemplate ?? "", ctx);
  return {
    ok: true,
    action: {
      kind: "agent",
      message,
      name: renderOptional(mapping.name, ctx),
      wakeMode: mapping.wakeMode ?? "now",
      sessionKey: renderOptional(mapping.sessionKey, ctx),
      deliver: mapping.deliver,
      channel: mapping.channel,
      to: renderOptional(mapping.to, ctx),
      thinking: renderOptional(mapping.thinking, ctx),
      timeoutSeconds: mapping.timeoutSeconds,
    },
  };
}

function mergeAction(
  base: HookAction,
  override: HookTransformResult,
  defaultAction: "wake" | "agent",
): HookMappingResult {
  if (!override) {
    return validateAction(base);
  }
  const kind = (override.kind ?? base.kind ?? defaultAction) as
    | "wake"
    | "agent";
  if (kind === "wake") {
    const baseWake = base.kind === "wake" ? base : undefined;
    const text =
      typeof override.text === "string"
        ? override.text
        : (baseWake?.text ?? "");
    const mode =
      override.mode === "next-heartbeat"
        ? "next-heartbeat"
        : (baseWake?.mode ?? "now");
    return validateAction({ kind: "wake", text, mode });
  }
  const baseAgent = base.kind === "agent" ? base : undefined;
  const message =
    typeof override.message === "string"
      ? override.message
      : (baseAgent?.message ?? "");
  const wakeMode =
    override.wakeMode === "next-heartbeat"
      ? "next-heartbeat"
      : (baseAgent?.wakeMode ?? "now");
  return validateAction({
    kind: "agent",
    message,
    wakeMode,
    name: override.name ?? baseAgent?.name,
    sessionKey: override.sessionKey ?? baseAgent?.sessionKey,
    deliver:
      typeof override.deliver === "boolean"
        ? override.deliver
        : baseAgent?.deliver,
    channel: override.channel ?? baseAgent?.channel,
    to: override.to ?? baseAgent?.to,
    thinking: override.thinking ?? baseAgent?.thinking,
    timeoutSeconds: override.timeoutSeconds ?? baseAgent?.timeoutSeconds,
  });
}

function validateAction(action: HookAction): HookMappingResult {
  if (action.kind === "wake") {
    if (!action.text?.trim()) {
      return { ok: false, error: "hook mapping requires text" };
    }
    return { ok: true, action };
  }
  if (!action.message?.trim()) {
    return { ok: false, error: "hook mapping requires message" };
  }
  return { ok: true, action };
}

async function loadTransform(
  transform: HookMappingTransformResolved,
): Promise<HookTransformFn> {
  const cached = transformCache.get(transform.modulePath);
  if (cached) return cached;
  const url = pathToFileURL(transform.modulePath).href;
  const mod = (await import(url)) as Record<string, unknown>;
  const fn = resolveTransformFn(mod, transform.exportName);
  transformCache.set(transform.modulePath, fn);
  return fn;
}

function resolveTransformFn(
  mod: Record<string, unknown>,
  exportName?: string,
): HookTransformFn {
  const candidate = exportName
    ? mod[exportName]
    : (mod.default ?? mod.transform);
  if (typeof candidate !== "function") {
    throw new Error("hook transform module must export a function");
  }
  return candidate as HookTransformFn;
}

function resolvePath(baseDir: string, target: string): string {
  if (!target) return baseDir;
  if (path.isAbsolute(target)) return target;
  return path.join(baseDir, target);
}

function normalizeMatchPath(raw?: string): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/^\/+/, "").replace(/\/+$/, "");
}

function renderOptional(value: string | undefined, ctx: HookMappingContext) {
  if (!value) return undefined;
  const rendered = renderTemplate(value, ctx).trim();
  return rendered ? rendered : undefined;
}

function renderTemplate(template: string, ctx: HookMappingContext) {
  if (!template) return "";
  return template.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_, expr: string) => {
    const value = resolveTemplateExpr(expr.trim(), ctx);
    if (value === undefined || value === null) return "";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean")
      return String(value);
    return JSON.stringify(value);
  });
}

function resolveTemplateExpr(expr: string, ctx: HookMappingContext) {
  if (expr === "path") return ctx.path;
  if (expr === "now") return new Date().toISOString();
  if (expr.startsWith("headers.")) {
    return getByPath(ctx.headers, expr.slice("headers.".length));
  }
  if (expr.startsWith("query.")) {
    return getByPath(
      Object.fromEntries(ctx.url.searchParams.entries()),
      expr.slice("query.".length),
    );
  }
  if (expr.startsWith("payload.")) {
    return getByPath(ctx.payload, expr.slice("payload.".length));
  }
  return getByPath(ctx.payload, expr);
}

function getByPath(input: Record<string, unknown>, pathExpr: string): unknown {
  if (!pathExpr) return undefined;
  const parts: Array<string | number> = [];
  const re = /([^.[\]]+)|(\[(\d+)\])/g;
  let match = re.exec(pathExpr);
  while (match) {
    if (match[1]) {
      parts.push(match[1]);
    } else if (match[3]) {
      parts.push(Number(match[3]));
    }
    match = re.exec(pathExpr);
  }
  let current: unknown = input;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof part === "number") {
      if (!Array.isArray(current)) return undefined;
      current = current[part] as unknown;
      continue;
    }
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
