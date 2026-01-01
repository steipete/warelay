import crypto from "node:crypto";
import fs from "node:fs/promises";

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-ai";
import { type TSchema, Type } from "@sinclair/typebox";
import {
  browserCloseTab,
  browserFocusTab,
  browserOpenTab,
  browserSnapshot,
  browserStart,
  browserStatus,
  browserStop,
  browserTabs,
} from "../browser/client.js";
import {
  browserAct,
  browserArmDialog,
  browserArmFileChooser,
  browserConsoleMessages,
  browserNavigate,
  browserPdfSave,
  browserScreenshotAction,
} from "../browser/client-actions.js";
import { resolveBrowserConfig } from "../browser/config.js";
import {
  type CameraFacing,
  cameraTempPath,
  parseCameraClipPayload,
  parseCameraSnapPayload,
  writeBase64ToFile,
} from "../cli/nodes-camera.js";
import {
  canvasSnapshotTempPath,
  parseCanvasSnapshotPayload,
} from "../cli/nodes-canvas.js";
import {
  parseScreenRecordPayload,
  screenRecordTempPath,
  writeScreenRecordToFile,
} from "../cli/nodes-screen.js";
import { parseDurationMs } from "../cli/parse-duration.js";
import { loadConfig } from "../config/config.js";
import { callGateway } from "../gateway/call.js";
import { detectMime } from "../media/mime.js";
import { sanitizeToolResultImages } from "./tool-images.js";

type AnyAgentTool = AgentTool<TSchema, unknown>;

const DEFAULT_GATEWAY_URL = "ws://127.0.0.1:18789";

type GatewayCallOptions = {
  gatewayUrl?: string;
  gatewayToken?: string;
  timeoutMs?: number;
};

function resolveGatewayOptions(opts?: GatewayCallOptions) {
  const url =
    typeof opts?.gatewayUrl === "string" && opts.gatewayUrl.trim()
      ? opts.gatewayUrl.trim()
      : DEFAULT_GATEWAY_URL;
  const token =
    typeof opts?.gatewayToken === "string" && opts.gatewayToken.trim()
      ? opts.gatewayToken.trim()
      : undefined;
  const timeoutMs =
    typeof opts?.timeoutMs === "number" && Number.isFinite(opts.timeoutMs)
      ? Math.max(1, Math.floor(opts.timeoutMs))
      : 10_000;
  return { url, token, timeoutMs };
}

type StringParamOptions = {
  required?: boolean;
  trim?: boolean;
  label?: string;
};

function readStringParam(
  params: Record<string, unknown>,
  key: string,
  options: StringParamOptions & { required: true },
): string;
function readStringParam(
  params: Record<string, unknown>,
  key: string,
  options?: StringParamOptions,
): string | undefined;
function readStringParam(
  params: Record<string, unknown>,
  key: string,
  options: StringParamOptions = {},
) {
  const { required = false, trim = true, label = key } = options;
  const raw = params[key];
  if (typeof raw !== "string") {
    if (required) throw new Error(`${label} required`);
    return undefined;
  }
  const value = trim ? raw.trim() : raw;
  if (!value) {
    if (required) throw new Error(`${label} required`);
    return undefined;
  }
  return value;
}

async function callGatewayTool<T = unknown>(
  method: string,
  opts: GatewayCallOptions,
  params?: unknown,
  extra?: { expectFinal?: boolean },
) {
  const gateway = resolveGatewayOptions(opts);
  return await callGateway<T>({
    url: gateway.url,
    token: gateway.token,
    method,
    params,
    timeoutMs: gateway.timeoutMs,
    expectFinal: extra?.expectFinal,
    clientName: "agent",
    mode: "agent",
  });
}

function jsonResult(payload: unknown): AgentToolResult<unknown> {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
    details: payload,
  };
}

async function imageResult(params: {
  label: string;
  path: string;
  base64: string;
  mimeType: string;
  extraText?: string;
  details?: Record<string, unknown>;
}): Promise<AgentToolResult<unknown>> {
  const content: AgentToolResult<unknown>["content"] = [
    {
      type: "text",
      text: params.extraText ?? `MEDIA:${params.path}`,
    },
    {
      type: "image",
      data: params.base64,
      mimeType: params.mimeType,
    },
  ];
  const result: AgentToolResult<unknown> = {
    content,
    details: { path: params.path, ...params.details },
  };
  return await sanitizeToolResultImages(result, params.label);
}

async function imageResultFromFile(params: {
  label: string;
  path: string;
  extraText?: string;
  details?: Record<string, unknown>;
}): Promise<AgentToolResult<unknown>> {
  const buf = await fs.readFile(params.path);
  const mimeType =
    (await detectMime({ buffer: buf.slice(0, 256) })) ?? "image/png";
  return await imageResult({
    label: params.label,
    path: params.path,
    base64: buf.toString("base64"),
    mimeType,
    extraText: params.extraText,
    details: params.details,
  });
}

function resolveBrowserBaseUrl(controlUrl?: string) {
  const cfg = loadConfig();
  const resolved = resolveBrowserConfig(cfg.browser);
  if (!resolved.enabled) {
    throw new Error(
      "Browser control is disabled. Set browser.enabled=true in ~/.clawdis/clawdis.json.",
    );
  }
  const url = controlUrl?.trim() ? controlUrl.trim() : resolved.controlUrl;
  return url.replace(/\/$/, "");
}

type NodeListNode = {
  nodeId: string;
  displayName?: string;
  platform?: string;
  remoteIp?: string;
  deviceFamily?: string;
  modelIdentifier?: string;
  caps?: string[];
  commands?: string[];
  permissions?: Record<string, boolean>;
  paired?: boolean;
  connected?: boolean;
};

type PendingRequest = {
  requestId: string;
  nodeId: string;
  displayName?: string;
  platform?: string;
  version?: string;
  remoteIp?: string;
  isRepair?: boolean;
  ts: number;
};

type PairedNode = {
  nodeId: string;
  token?: string;
  displayName?: string;
  platform?: string;
  version?: string;
  remoteIp?: string;
  permissions?: Record<string, boolean>;
  createdAtMs?: number;
  approvedAtMs?: number;
};

type PairingList = {
  pending: PendingRequest[];
  paired: PairedNode[];
};

function parseNodeList(value: unknown): NodeListNode[] {
  const obj =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
  return Array.isArray(obj.nodes) ? (obj.nodes as NodeListNode[]) : [];
}

function parsePairingList(value: unknown): PairingList {
  const obj =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
  const pending = Array.isArray(obj.pending)
    ? (obj.pending as PendingRequest[])
    : [];
  const paired = Array.isArray(obj.paired) ? (obj.paired as PairedNode[]) : [];
  return { pending, paired };
}

function normalizeNodeKey(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

async function loadNodes(opts: GatewayCallOptions): Promise<NodeListNode[]> {
  try {
    const res = (await callGatewayTool("node.list", opts, {})) as unknown;
    return parseNodeList(res);
  } catch {
    const res = (await callGatewayTool("node.pair.list", opts, {})) as unknown;
    const { paired } = parsePairingList(res);
    return paired.map((n) => ({
      nodeId: n.nodeId,
      displayName: n.displayName,
      platform: n.platform,
      remoteIp: n.remoteIp,
    }));
  }
}

function pickDefaultNode(nodes: NodeListNode[]): NodeListNode | null {
  const withCanvas = nodes.filter((n) =>
    Array.isArray(n.caps) ? n.caps.includes("canvas") : true,
  );
  if (withCanvas.length === 0) return null;

  const connected = withCanvas.filter((n) => n.connected);
  const candidates = connected.length > 0 ? connected : withCanvas;
  if (candidates.length === 1) return candidates[0];

  const local = candidates.filter(
    (n) =>
      n.platform?.toLowerCase().startsWith("mac") &&
      typeof n.nodeId === "string" &&
      n.nodeId.startsWith("mac-"),
  );
  if (local.length === 1) return local[0];

  return null;
}

async function resolveNodeId(
  opts: GatewayCallOptions,
  query?: string,
  allowDefault = false,
) {
  const nodes = await loadNodes(opts);
  const q = String(query ?? "").trim();
  if (!q) {
    if (allowDefault) {
      const picked = pickDefaultNode(nodes);
      if (picked) return picked.nodeId;
    }
    throw new Error("node required");
  }

  const qNorm = normalizeNodeKey(q);
  const matches = nodes.filter((n) => {
    if (n.nodeId === q) return true;
    if (typeof n.remoteIp === "string" && n.remoteIp === q) return true;
    const name = typeof n.displayName === "string" ? n.displayName : "";
    if (name && normalizeNodeKey(name) === qNorm) return true;
    if (q.length >= 6 && n.nodeId.startsWith(q)) return true;
    return false;
  });

  if (matches.length === 1) return matches[0].nodeId;
  if (matches.length === 0) {
    const known = nodes
      .map((n) => n.displayName || n.remoteIp || n.nodeId)
      .filter(Boolean)
      .join(", ");
    throw new Error(`unknown node: ${q}${known ? ` (known: ${known})` : ""}`);
  }
  throw new Error(
    `ambiguous node: ${q} (matches: ${matches
      .map((n) => n.displayName || n.remoteIp || n.nodeId)
      .join(", ")})`,
  );
}

const BrowserActSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("click"),
    ref: Type.String(),
    targetId: Type.Optional(Type.String()),
    doubleClick: Type.Optional(Type.Boolean()),
    button: Type.Optional(Type.String()),
    modifiers: Type.Optional(Type.Array(Type.String())),
  }),
  Type.Object({
    kind: Type.Literal("type"),
    ref: Type.String(),
    text: Type.String(),
    targetId: Type.Optional(Type.String()),
    submit: Type.Optional(Type.Boolean()),
    slowly: Type.Optional(Type.Boolean()),
  }),
  Type.Object({
    kind: Type.Literal("press"),
    key: Type.String(),
    targetId: Type.Optional(Type.String()),
  }),
  Type.Object({
    kind: Type.Literal("hover"),
    ref: Type.String(),
    targetId: Type.Optional(Type.String()),
  }),
  Type.Object({
    kind: Type.Literal("drag"),
    startRef: Type.String(),
    endRef: Type.String(),
    targetId: Type.Optional(Type.String()),
  }),
  Type.Object({
    kind: Type.Literal("select"),
    ref: Type.String(),
    values: Type.Array(Type.String()),
    targetId: Type.Optional(Type.String()),
  }),
  Type.Object({
    kind: Type.Literal("fill"),
    fields: Type.Array(Type.Record(Type.String(), Type.Unknown())),
    targetId: Type.Optional(Type.String()),
  }),
  Type.Object({
    kind: Type.Literal("resize"),
    width: Type.Number(),
    height: Type.Number(),
    targetId: Type.Optional(Type.String()),
  }),
  Type.Object({
    kind: Type.Literal("wait"),
    timeMs: Type.Optional(Type.Number()),
    text: Type.Optional(Type.String()),
    textGone: Type.Optional(Type.String()),
    targetId: Type.Optional(Type.String()),
  }),
  Type.Object({
    kind: Type.Literal("evaluate"),
    fn: Type.String(),
    ref: Type.Optional(Type.String()),
    targetId: Type.Optional(Type.String()),
  }),
  Type.Object({
    kind: Type.Literal("close"),
    targetId: Type.Optional(Type.String()),
  }),
]);

const BrowserToolSchema = Type.Union([
  Type.Object({
    action: Type.Literal("status"),
    controlUrl: Type.Optional(Type.String()),
  }),
  Type.Object({
    action: Type.Literal("start"),
    controlUrl: Type.Optional(Type.String()),
  }),
  Type.Object({
    action: Type.Literal("stop"),
    controlUrl: Type.Optional(Type.String()),
  }),
  Type.Object({
    action: Type.Literal("tabs"),
    controlUrl: Type.Optional(Type.String()),
  }),
  Type.Object({
    action: Type.Literal("open"),
    controlUrl: Type.Optional(Type.String()),
    targetUrl: Type.String(),
  }),
  Type.Object({
    action: Type.Literal("focus"),
    controlUrl: Type.Optional(Type.String()),
    targetId: Type.String(),
  }),
  Type.Object({
    action: Type.Literal("close"),
    controlUrl: Type.Optional(Type.String()),
    targetId: Type.Optional(Type.String()),
  }),
  Type.Object({
    action: Type.Literal("snapshot"),
    controlUrl: Type.Optional(Type.String()),
    format: Type.Optional(
      Type.Union([Type.Literal("aria"), Type.Literal("ai")]),
    ),
    targetId: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Number()),
  }),
  Type.Object({
    action: Type.Literal("screenshot"),
    controlUrl: Type.Optional(Type.String()),
    targetId: Type.Optional(Type.String()),
    fullPage: Type.Optional(Type.Boolean()),
    ref: Type.Optional(Type.String()),
    element: Type.Optional(Type.String()),
    type: Type.Optional(
      Type.Union([Type.Literal("png"), Type.Literal("jpeg")]),
    ),
  }),
  Type.Object({
    action: Type.Literal("navigate"),
    controlUrl: Type.Optional(Type.String()),
    targetUrl: Type.String(),
    targetId: Type.Optional(Type.String()),
  }),
  Type.Object({
    action: Type.Literal("console"),
    controlUrl: Type.Optional(Type.String()),
    level: Type.Optional(Type.String()),
    targetId: Type.Optional(Type.String()),
  }),
  Type.Object({
    action: Type.Literal("pdf"),
    controlUrl: Type.Optional(Type.String()),
    targetId: Type.Optional(Type.String()),
  }),
  Type.Object({
    action: Type.Literal("upload"),
    controlUrl: Type.Optional(Type.String()),
    paths: Type.Array(Type.String()),
    ref: Type.Optional(Type.String()),
    inputRef: Type.Optional(Type.String()),
    element: Type.Optional(Type.String()),
    targetId: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
  }),
  Type.Object({
    action: Type.Literal("dialog"),
    controlUrl: Type.Optional(Type.String()),
    accept: Type.Boolean(),
    promptText: Type.Optional(Type.String()),
    targetId: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
  }),
  Type.Object({
    action: Type.Literal("act"),
    controlUrl: Type.Optional(Type.String()),
    request: BrowserActSchema,
  }),
]);

function createBrowserTool(): AnyAgentTool {
  return {
    label: "Clawdis Browser",
    name: "clawdis_browser",
    description:
      "Control clawd's dedicated browser (status/start/stop/tabs/open/snapshot/screenshot/actions). Use snapshot+act for UI automation. Avoid act:wait by default; use only in exceptional cases when no reliable UI state exists.",
    parameters: BrowserToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const controlUrl = readStringParam(params, "controlUrl");
      const baseUrl = resolveBrowserBaseUrl(controlUrl);

      switch (action) {
        case "status":
          return jsonResult(await browserStatus(baseUrl));
        case "start":
          await browserStart(baseUrl);
          return jsonResult(await browserStatus(baseUrl));
        case "stop":
          await browserStop(baseUrl);
          return jsonResult(await browserStatus(baseUrl));
        case "tabs":
          return jsonResult({ tabs: await browserTabs(baseUrl) });
        case "open": {
          const targetUrl = readStringParam(params, "targetUrl", {
            required: true,
          });
          return jsonResult(await browserOpenTab(baseUrl, targetUrl));
        }
        case "focus": {
          const targetId = readStringParam(params, "targetId", {
            required: true,
          });
          await browserFocusTab(baseUrl, targetId);
          return jsonResult({ ok: true });
        }
        case "close": {
          const targetId = readStringParam(params, "targetId");
          if (targetId) await browserCloseTab(baseUrl, targetId);
          else await browserAct(baseUrl, { kind: "close" });
          return jsonResult({ ok: true });
        }
        case "snapshot": {
          const format =
            params.format === "ai" || params.format === "aria"
              ? (params.format as "ai" | "aria")
              : "ai";
          const targetId =
            typeof params.targetId === "string"
              ? params.targetId.trim()
              : undefined;
          const limit =
            typeof params.limit === "number" && Number.isFinite(params.limit)
              ? params.limit
              : undefined;
          const snapshot = await browserSnapshot(baseUrl, {
            format,
            targetId,
            limit,
          });
          if (snapshot.format === "ai") {
            return {
              content: [{ type: "text", text: snapshot.snapshot }],
              details: snapshot,
            };
          }
          return jsonResult(snapshot);
        }
        case "screenshot": {
          const targetId = readStringParam(params, "targetId");
          const fullPage = Boolean(params.fullPage);
          const ref = readStringParam(params, "ref");
          const element = readStringParam(params, "element");
          const type = params.type === "jpeg" ? "jpeg" : "png";
          const result = await browserScreenshotAction(baseUrl, {
            targetId,
            fullPage,
            ref,
            element,
            type,
          });
          return await imageResultFromFile({
            label: "browser:screenshot",
            path: result.path,
            details: result,
          });
        }
        case "navigate": {
          const targetUrl = readStringParam(params, "targetUrl", {
            required: true,
          });
          const targetId = readStringParam(params, "targetId");
          return jsonResult(
            await browserNavigate(baseUrl, { url: targetUrl, targetId }),
          );
        }
        case "console": {
          const level =
            typeof params.level === "string" ? params.level.trim() : undefined;
          const targetId =
            typeof params.targetId === "string"
              ? params.targetId.trim()
              : undefined;
          return jsonResult(
            await browserConsoleMessages(baseUrl, { level, targetId }),
          );
        }
        case "pdf": {
          const targetId =
            typeof params.targetId === "string"
              ? params.targetId.trim()
              : undefined;
          const result = await browserPdfSave(baseUrl, { targetId });
          return {
            content: [{ type: "text", text: `FILE:${result.path}` }],
            details: result,
          };
        }
        case "upload": {
          const paths = Array.isArray(params.paths)
            ? params.paths.map((p) => String(p))
            : [];
          if (paths.length === 0) throw new Error("paths required");
          const ref = readStringParam(params, "ref");
          const inputRef = readStringParam(params, "inputRef");
          const element = readStringParam(params, "element");
          const targetId =
            typeof params.targetId === "string"
              ? params.targetId.trim()
              : undefined;
          const timeoutMs =
            typeof params.timeoutMs === "number" &&
            Number.isFinite(params.timeoutMs)
              ? params.timeoutMs
              : undefined;
          return jsonResult(
            await browserArmFileChooser(baseUrl, {
              paths,
              ref,
              inputRef,
              element,
              targetId,
              timeoutMs,
            }),
          );
        }
        case "dialog": {
          const accept = Boolean(params.accept);
          const promptText =
            typeof params.promptText === "string"
              ? params.promptText
              : undefined;
          const targetId =
            typeof params.targetId === "string"
              ? params.targetId.trim()
              : undefined;
          const timeoutMs =
            typeof params.timeoutMs === "number" &&
            Number.isFinite(params.timeoutMs)
              ? params.timeoutMs
              : undefined;
          return jsonResult(
            await browserArmDialog(baseUrl, {
              accept,
              promptText,
              targetId,
              timeoutMs,
            }),
          );
        }
        case "act": {
          const request = params.request as Record<string, unknown> | undefined;
          if (!request || typeof request !== "object") {
            throw new Error("request required");
          }
          const result = await browserAct(
            baseUrl,
            request as Parameters<typeof browserAct>[1],
          );
          return jsonResult(result);
        }
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    },
  };
}

const CanvasToolSchema = Type.Union([
  Type.Object({
    action: Type.Literal("present"),
    gatewayUrl: Type.Optional(Type.String()),
    gatewayToken: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
    node: Type.Optional(Type.String()),
    target: Type.Optional(Type.String()),
    x: Type.Optional(Type.Number()),
    y: Type.Optional(Type.Number()),
    width: Type.Optional(Type.Number()),
    height: Type.Optional(Type.Number()),
  }),
  Type.Object({
    action: Type.Literal("hide"),
    gatewayUrl: Type.Optional(Type.String()),
    gatewayToken: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
    node: Type.Optional(Type.String()),
  }),
  Type.Object({
    action: Type.Literal("navigate"),
    gatewayUrl: Type.Optional(Type.String()),
    gatewayToken: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
    node: Type.Optional(Type.String()),
    url: Type.String(),
  }),
  Type.Object({
    action: Type.Literal("eval"),
    gatewayUrl: Type.Optional(Type.String()),
    gatewayToken: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
    node: Type.Optional(Type.String()),
    javaScript: Type.String(),
  }),
  Type.Object({
    action: Type.Literal("snapshot"),
    gatewayUrl: Type.Optional(Type.String()),
    gatewayToken: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
    node: Type.Optional(Type.String()),
    format: Type.Optional(
      Type.Union([
        Type.Literal("png"),
        Type.Literal("jpg"),
        Type.Literal("jpeg"),
      ]),
    ),
    maxWidth: Type.Optional(Type.Number()),
    quality: Type.Optional(Type.Number()),
  }),
  Type.Object({
    action: Type.Literal("a2ui_push"),
    gatewayUrl: Type.Optional(Type.String()),
    gatewayToken: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
    node: Type.Optional(Type.String()),
    jsonl: Type.Optional(Type.String()),
    jsonlPath: Type.Optional(Type.String()),
  }),
  Type.Object({
    action: Type.Literal("a2ui_reset"),
    gatewayUrl: Type.Optional(Type.String()),
    gatewayToken: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
    node: Type.Optional(Type.String()),
  }),
]);

function createCanvasTool(): AnyAgentTool {
  return {
    label: "Clawdis Canvas",
    name: "clawdis_canvas",
    description:
      "Control node canvases (present/hide/navigate/eval/snapshot/A2UI). Use snapshot to capture the rendered UI.",
    parameters: CanvasToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const gatewayOpts: GatewayCallOptions = {
        gatewayUrl: readStringParam(params, "gatewayUrl", { trim: false }),
        gatewayToken: readStringParam(params, "gatewayToken", { trim: false }),
        timeoutMs:
          typeof params.timeoutMs === "number" ? params.timeoutMs : undefined,
      };

      const nodeId = await resolveNodeId(
        gatewayOpts,
        readStringParam(params, "node", { trim: true }),
        true,
      );

      const invoke = async (
        command: string,
        invokeParams?: Record<string, unknown>,
      ) =>
        await callGatewayTool("node.invoke", gatewayOpts, {
          nodeId,
          command,
          params: invokeParams,
          idempotencyKey: crypto.randomUUID(),
        });

      switch (action) {
        case "present": {
          const placement = {
            x: typeof params.x === "number" ? params.x : undefined,
            y: typeof params.y === "number" ? params.y : undefined,
            width: typeof params.width === "number" ? params.width : undefined,
            height:
              typeof params.height === "number" ? params.height : undefined,
          };
          const invokeParams: Record<string, unknown> = {};
          if (typeof params.target === "string" && params.target.trim()) {
            invokeParams.url = params.target.trim();
          }
          if (
            Number.isFinite(placement.x) ||
            Number.isFinite(placement.y) ||
            Number.isFinite(placement.width) ||
            Number.isFinite(placement.height)
          ) {
            invokeParams.placement = placement;
          }
          await invoke("canvas.present", invokeParams);
          return jsonResult({ ok: true });
        }
        case "hide":
          await invoke("canvas.hide", undefined);
          return jsonResult({ ok: true });
        case "navigate": {
          const url = readStringParam(params, "url", { required: true });
          await invoke("canvas.navigate", { url });
          return jsonResult({ ok: true });
        }
        case "eval": {
          const javaScript = readStringParam(params, "javaScript", {
            required: true,
          });
          const raw = (await invoke("canvas.eval", { javaScript })) as {
            payload?: { result?: string };
          };
          const result = raw?.payload?.result;
          if (result) {
            return {
              content: [{ type: "text", text: result }],
              details: { result },
            };
          }
          return jsonResult({ ok: true });
        }
        case "snapshot": {
          const formatRaw =
            typeof params.format === "string"
              ? params.format.toLowerCase()
              : "png";
          const format =
            formatRaw === "jpg" || formatRaw === "jpeg" ? "jpeg" : "png";
          const maxWidth =
            typeof params.maxWidth === "number" &&
            Number.isFinite(params.maxWidth)
              ? params.maxWidth
              : undefined;
          const quality =
            typeof params.quality === "number" &&
            Number.isFinite(params.quality)
              ? params.quality
              : undefined;
          const raw = (await invoke("canvas.snapshot", {
            format,
            maxWidth,
            quality,
          })) as { payload?: unknown };
          const payload = parseCanvasSnapshotPayload(raw?.payload);
          const filePath = canvasSnapshotTempPath({
            ext: payload.format === "jpeg" ? "jpg" : payload.format,
          });
          await writeBase64ToFile(filePath, payload.base64);
          const mimeType =
            payload.format === "jpeg" ? "image/jpeg" : "image/png";
          return await imageResult({
            label: "canvas:snapshot",
            path: filePath,
            base64: payload.base64,
            mimeType,
            details: { format: payload.format },
          });
        }
        case "a2ui_push": {
          const jsonl =
            typeof params.jsonl === "string" && params.jsonl.trim()
              ? params.jsonl
              : typeof params.jsonlPath === "string" && params.jsonlPath.trim()
                ? await fs.readFile(params.jsonlPath.trim(), "utf8")
                : "";
          if (!jsonl.trim()) throw new Error("jsonl or jsonlPath required");
          await invoke("canvas.a2ui.pushJSONL", { jsonl });
          return jsonResult({ ok: true });
        }
        case "a2ui_reset":
          await invoke("canvas.a2ui.reset", undefined);
          return jsonResult({ ok: true });
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    },
  };
}

const NodesToolSchema = Type.Union([
  Type.Object({
    action: Type.Literal("status"),
    gatewayUrl: Type.Optional(Type.String()),
    gatewayToken: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
  }),
  Type.Object({
    action: Type.Literal("describe"),
    gatewayUrl: Type.Optional(Type.String()),
    gatewayToken: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
    node: Type.String(),
  }),
  Type.Object({
    action: Type.Literal("pending"),
    gatewayUrl: Type.Optional(Type.String()),
    gatewayToken: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
  }),
  Type.Object({
    action: Type.Literal("approve"),
    gatewayUrl: Type.Optional(Type.String()),
    gatewayToken: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
    requestId: Type.String(),
  }),
  Type.Object({
    action: Type.Literal("reject"),
    gatewayUrl: Type.Optional(Type.String()),
    gatewayToken: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
    requestId: Type.String(),
  }),
  Type.Object({
    action: Type.Literal("notify"),
    gatewayUrl: Type.Optional(Type.String()),
    gatewayToken: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
    node: Type.String(),
    title: Type.Optional(Type.String()),
    body: Type.Optional(Type.String()),
    sound: Type.Optional(Type.String()),
    priority: Type.Optional(
      Type.Union([
        Type.Literal("passive"),
        Type.Literal("active"),
        Type.Literal("timeSensitive"),
      ]),
    ),
    delivery: Type.Optional(
      Type.Union([
        Type.Literal("system"),
        Type.Literal("overlay"),
        Type.Literal("auto"),
      ]),
    ),
  }),
  Type.Object({
    action: Type.Literal("camera_snap"),
    gatewayUrl: Type.Optional(Type.String()),
    gatewayToken: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
    node: Type.String(),
    facing: Type.Optional(
      Type.Union([
        Type.Literal("front"),
        Type.Literal("back"),
        Type.Literal("both"),
      ]),
    ),
    maxWidth: Type.Optional(Type.Number()),
    quality: Type.Optional(Type.Number()),
  }),
  Type.Object({
    action: Type.Literal("camera_clip"),
    gatewayUrl: Type.Optional(Type.String()),
    gatewayToken: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
    node: Type.String(),
    facing: Type.Optional(
      Type.Union([Type.Literal("front"), Type.Literal("back")]),
    ),
    duration: Type.Optional(Type.String()),
    durationMs: Type.Optional(Type.Number()),
    includeAudio: Type.Optional(Type.Boolean()),
  }),
  Type.Object({
    action: Type.Literal("screen_record"),
    gatewayUrl: Type.Optional(Type.String()),
    gatewayToken: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
    node: Type.String(),
    duration: Type.Optional(Type.String()),
    durationMs: Type.Optional(Type.Number()),
    fps: Type.Optional(Type.Number()),
    screenIndex: Type.Optional(Type.Number()),
    includeAudio: Type.Optional(Type.Boolean()),
    outPath: Type.Optional(Type.String()),
  }),
]);

function createNodesTool(): AnyAgentTool {
  return {
    label: "Clawdis Nodes",
    name: "clawdis_nodes",
    description:
      "Discover and control paired nodes (status/describe/pairing/notify/camera/screen).",
    parameters: NodesToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const gatewayOpts: GatewayCallOptions = {
        gatewayUrl: readStringParam(params, "gatewayUrl", { trim: false }),
        gatewayToken: readStringParam(params, "gatewayToken", { trim: false }),
        timeoutMs:
          typeof params.timeoutMs === "number" ? params.timeoutMs : undefined,
      };

      switch (action) {
        case "status":
          return jsonResult(
            await callGatewayTool("node.list", gatewayOpts, {}),
          );
        case "describe": {
          const node = readStringParam(params, "node", { required: true });
          const nodeId = await resolveNodeId(gatewayOpts, node);
          return jsonResult(
            await callGatewayTool("node.describe", gatewayOpts, { nodeId }),
          );
        }
        case "pending":
          return jsonResult(
            await callGatewayTool("node.pair.list", gatewayOpts, {}),
          );
        case "approve": {
          const requestId = readStringParam(params, "requestId", {
            required: true,
          });
          return jsonResult(
            await callGatewayTool("node.pair.approve", gatewayOpts, {
              requestId,
            }),
          );
        }
        case "reject": {
          const requestId = readStringParam(params, "requestId", {
            required: true,
          });
          return jsonResult(
            await callGatewayTool("node.pair.reject", gatewayOpts, {
              requestId,
            }),
          );
        }
        case "notify": {
          const node = readStringParam(params, "node", { required: true });
          const title = typeof params.title === "string" ? params.title : "";
          const body = typeof params.body === "string" ? params.body : "";
          if (!title.trim() && !body.trim()) {
            throw new Error("title or body required");
          }
          const nodeId = await resolveNodeId(gatewayOpts, node);
          await callGatewayTool("node.invoke", gatewayOpts, {
            nodeId,
            command: "system.notify",
            params: {
              title: title.trim() || undefined,
              body: body.trim() || undefined,
              sound:
                typeof params.sound === "string" ? params.sound : undefined,
              priority:
                typeof params.priority === "string"
                  ? params.priority
                  : undefined,
              delivery:
                typeof params.delivery === "string"
                  ? params.delivery
                  : undefined,
            },
            idempotencyKey: crypto.randomUUID(),
          });
          return jsonResult({ ok: true });
        }
        case "camera_snap": {
          const node = readStringParam(params, "node", { required: true });
          const nodeId = await resolveNodeId(gatewayOpts, node);
          const facingRaw =
            typeof params.facing === "string"
              ? params.facing.toLowerCase()
              : "both";
          const facings: CameraFacing[] =
            facingRaw === "both"
              ? ["front", "back"]
              : facingRaw === "front" || facingRaw === "back"
                ? [facingRaw]
                : (() => {
                    throw new Error("invalid facing (front|back|both)");
                  })();
          const maxWidth =
            typeof params.maxWidth === "number" &&
            Number.isFinite(params.maxWidth)
              ? params.maxWidth
              : undefined;
          const quality =
            typeof params.quality === "number" &&
            Number.isFinite(params.quality)
              ? params.quality
              : undefined;

          const content: AgentToolResult<unknown>["content"] = [];
          const details: Array<Record<string, unknown>> = [];

          for (const facing of facings) {
            const raw = (await callGatewayTool("node.invoke", gatewayOpts, {
              nodeId,
              command: "camera.snap",
              params: {
                facing,
                maxWidth,
                quality,
                format: "jpg",
              },
              idempotencyKey: crypto.randomUUID(),
            })) as { payload?: unknown };
            const payload = parseCameraSnapPayload(raw?.payload);
            const filePath = cameraTempPath({
              kind: "snap",
              facing,
              ext: payload.format === "jpeg" ? "jpg" : payload.format,
            });
            await writeBase64ToFile(filePath, payload.base64);
            content.push({ type: "text", text: `MEDIA:${filePath}` });
            content.push({
              type: "image",
              data: payload.base64,
              mimeType: payload.format === "jpeg" ? "image/jpeg" : "image/png",
            });
            details.push({
              facing,
              path: filePath,
              width: payload.width,
              height: payload.height,
            });
          }

          const result: AgentToolResult<unknown> = { content, details };
          return await sanitizeToolResultImages(result, "nodes:camera_snap");
        }
        case "camera_clip": {
          const node = readStringParam(params, "node", { required: true });
          const nodeId = await resolveNodeId(gatewayOpts, node);
          const facing =
            typeof params.facing === "string"
              ? params.facing.toLowerCase()
              : "front";
          if (facing !== "front" && facing !== "back") {
            throw new Error("invalid facing (front|back)");
          }
          const durationMs =
            typeof params.durationMs === "number" &&
            Number.isFinite(params.durationMs)
              ? params.durationMs
              : typeof params.duration === "string"
                ? parseDurationMs(params.duration)
                : 3000;
          const includeAudio =
            typeof params.includeAudio === "boolean"
              ? params.includeAudio
              : true;
          const raw = (await callGatewayTool("node.invoke", gatewayOpts, {
            nodeId,
            command: "camera.clip",
            params: {
              facing,
              durationMs,
              includeAudio,
              format: "mp4",
            },
            idempotencyKey: crypto.randomUUID(),
          })) as { payload?: unknown };
          const payload = parseCameraClipPayload(raw?.payload);
          const filePath = cameraTempPath({
            kind: "clip",
            facing,
            ext: payload.format,
          });
          await writeBase64ToFile(filePath, payload.base64);
          return {
            content: [{ type: "text", text: `FILE:${filePath}` }],
            details: {
              facing,
              path: filePath,
              durationMs: payload.durationMs,
              hasAudio: payload.hasAudio,
            },
          };
        }
        case "screen_record": {
          const node = readStringParam(params, "node", { required: true });
          const nodeId = await resolveNodeId(gatewayOpts, node);
          const durationMs =
            typeof params.durationMs === "number" &&
            Number.isFinite(params.durationMs)
              ? params.durationMs
              : typeof params.duration === "string"
                ? parseDurationMs(params.duration)
                : 10_000;
          const fps =
            typeof params.fps === "number" && Number.isFinite(params.fps)
              ? params.fps
              : 10;
          const screenIndex =
            typeof params.screenIndex === "number" &&
            Number.isFinite(params.screenIndex)
              ? params.screenIndex
              : 0;
          const includeAudio =
            typeof params.includeAudio === "boolean"
              ? params.includeAudio
              : true;
          const raw = (await callGatewayTool("node.invoke", gatewayOpts, {
            nodeId,
            command: "screen.record",
            params: {
              durationMs,
              screenIndex,
              fps,
              format: "mp4",
              includeAudio,
            },
            idempotencyKey: crypto.randomUUID(),
          })) as { payload?: unknown };
          const payload = parseScreenRecordPayload(raw?.payload);
          const filePath =
            typeof params.outPath === "string" && params.outPath.trim()
              ? params.outPath.trim()
              : screenRecordTempPath({ ext: payload.format || "mp4" });
          const written = await writeScreenRecordToFile(
            filePath,
            payload.base64,
          );
          return {
            content: [{ type: "text", text: `FILE:${written.path}` }],
            details: {
              path: written.path,
              durationMs: payload.durationMs,
              fps: payload.fps,
              screenIndex: payload.screenIndex,
              hasAudio: payload.hasAudio,
            },
          };
        }
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    },
  };
}

const CronToolSchema = Type.Union([
  Type.Object({
    action: Type.Literal("status"),
    gatewayUrl: Type.Optional(Type.String()),
    gatewayToken: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
  }),
  Type.Object({
    action: Type.Literal("list"),
    gatewayUrl: Type.Optional(Type.String()),
    gatewayToken: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
    includeDisabled: Type.Optional(Type.Boolean()),
  }),
  Type.Object({
    action: Type.Literal("add"),
    gatewayUrl: Type.Optional(Type.String()),
    gatewayToken: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
    job: Type.Object({}, { additionalProperties: true }),
  }),
  Type.Object({
    action: Type.Literal("update"),
    gatewayUrl: Type.Optional(Type.String()),
    gatewayToken: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
    jobId: Type.String(),
    patch: Type.Object({}, { additionalProperties: true }),
  }),
  Type.Object({
    action: Type.Literal("remove"),
    gatewayUrl: Type.Optional(Type.String()),
    gatewayToken: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
    jobId: Type.String(),
  }),
  Type.Object({
    action: Type.Literal("run"),
    gatewayUrl: Type.Optional(Type.String()),
    gatewayToken: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
    jobId: Type.String(),
  }),
  Type.Object({
    action: Type.Literal("runs"),
    gatewayUrl: Type.Optional(Type.String()),
    gatewayToken: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
    jobId: Type.String(),
  }),
  Type.Object({
    action: Type.Literal("wake"),
    gatewayUrl: Type.Optional(Type.String()),
    gatewayToken: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
    text: Type.String(),
    mode: Type.Optional(
      Type.Union([Type.Literal("now"), Type.Literal("next-heartbeat")]),
    ),
  }),
]);

function createCronTool(): AnyAgentTool {
  return {
    label: "Clawdis Cron",
    name: "clawdis_cron",
    description:
      "Manage Gateway cron jobs (status/list/add/update/remove/run/runs) and send wake events.",
    parameters: CronToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const gatewayOpts: GatewayCallOptions = {
        gatewayUrl: readStringParam(params, "gatewayUrl", { trim: false }),
        gatewayToken: readStringParam(params, "gatewayToken", { trim: false }),
        timeoutMs:
          typeof params.timeoutMs === "number" ? params.timeoutMs : undefined,
      };

      switch (action) {
        case "status":
          return jsonResult(
            await callGatewayTool("cron.status", gatewayOpts, {}),
          );
        case "list":
          return jsonResult(
            await callGatewayTool("cron.list", gatewayOpts, {
              includeDisabled: Boolean(params.includeDisabled),
            }),
          );
        case "add": {
          if (!params.job || typeof params.job !== "object") {
            throw new Error("job required");
          }
          return jsonResult(
            await callGatewayTool("cron.add", gatewayOpts, params.job),
          );
        }
        case "update": {
          const jobId = readStringParam(params, "jobId", { required: true });
          if (!params.patch || typeof params.patch !== "object") {
            throw new Error("patch required");
          }
          return jsonResult(
            await callGatewayTool("cron.update", gatewayOpts, {
              jobId,
              patch: params.patch,
            }),
          );
        }
        case "remove": {
          const jobId = readStringParam(params, "jobId", { required: true });
          return jsonResult(
            await callGatewayTool("cron.remove", gatewayOpts, { jobId }),
          );
        }
        case "run": {
          const jobId = readStringParam(params, "jobId", { required: true });
          return jsonResult(
            await callGatewayTool("cron.run", gatewayOpts, { jobId }),
          );
        }
        case "runs": {
          const jobId = readStringParam(params, "jobId", { required: true });
          return jsonResult(
            await callGatewayTool("cron.runs", gatewayOpts, { jobId }),
          );
        }
        case "wake": {
          const text = readStringParam(params, "text", { required: true });
          const mode =
            params.mode === "now" || params.mode === "next-heartbeat"
              ? params.mode
              : "next-heartbeat";
          return jsonResult(
            await callGatewayTool(
              "wake",
              gatewayOpts,
              { mode, text },
              { expectFinal: false },
            ),
          );
        }
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    },
  };
}

const GatewayToolSchema = Type.Union([
  Type.Object({
    action: Type.Literal("restart"),
    delayMs: Type.Optional(Type.Number()),
    reason: Type.Optional(Type.String()),
  }),
]);

function createGatewayTool(): AnyAgentTool {
  return {
    label: "Clawdis Gateway",
    name: "clawdis_gateway",
    description:
      "Restart the running gateway process in-place (SIGUSR1) without needing an external supervisor. Use delayMs to avoid interrupting an in-flight reply.",
    parameters: GatewayToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      if (action !== "restart") throw new Error(`Unknown action: ${action}`);

      const delayMsRaw =
        typeof params.delayMs === "number" && Number.isFinite(params.delayMs)
          ? Math.floor(params.delayMs)
          : 2000;
      const delayMs = Math.min(Math.max(delayMsRaw, 0), 60_000);
      const reason =
        typeof params.reason === "string" && params.reason.trim()
          ? params.reason.trim().slice(0, 200)
          : undefined;

      const pid = process.pid;
      setTimeout(() => {
        try {
          process.kill(pid, "SIGUSR1");
        } catch {
          /* ignore */
        }
      }, delayMs);

      return jsonResult({
        ok: true,
        pid,
        signal: "SIGUSR1",
        delayMs,
        reason: reason ?? null,
      });
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Send Message Tool
// ─────────────────────────────────────────────────────────────────────────────

const SendMessageSchema = Type.Object({
  to: Type.String({ description: "Recipient phone (E.164) or channel ID" }),
  message: Type.String({ description: "Message text to send" }),
  provider: Type.Optional(
    Type.Union([
      Type.Literal("whatsapp"),
      Type.Literal("telegram"),
      Type.Literal("discord"),
    ]),
  ),
  mediaUrl: Type.Optional(
    Type.String({ description: "Media URL to attach (image, audio, video)" }),
  ),
  gatewayUrl: Type.Optional(Type.String()),
  gatewayToken: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Number()),
});

function createSendMessageTool(): AnyAgentTool {
  return {
    label: "Send Message",
    name: "clawdis_send",
    description:
      "Send a message to a user via WhatsApp, Telegram, or Discord. Use this to proactively reach out to users without waiting for them to message first.",
    parameters: SendMessageSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const to = readStringParam(params, "to", { required: true });
      const message = readStringParam(params, "message", { required: true });
      const provider = readStringParam(params, "provider") ?? "whatsapp";
      const mediaUrl = readStringParam(params, "mediaUrl");
      const gatewayOpts: GatewayCallOptions = {
        gatewayUrl: readStringParam(params, "gatewayUrl", { trim: false }),
        gatewayToken: readStringParam(params, "gatewayToken", { trim: false }),
        timeoutMs:
          typeof params.timeoutMs === "number" ? params.timeoutMs : undefined,
      };

      // Prefix messages with Zee identifier so recipients know it's the assistant
      const prefixedMessage = `🤖 Zee: ${message}`;

      const result = await callGatewayTool("send", gatewayOpts, {
        to,
        message: prefixedMessage,
        provider,
        mediaUrl,
        idempotencyKey: crypto.randomUUID(),
      });

      return jsonResult(result);
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Home Assistant Tool
// ─────────────────────────────────────────────────────────────────────────────

const HomeAssistantSchema = Type.Object({
  action: Type.Union([
    Type.Literal("call_service"),
    Type.Literal("get_state"),
    Type.Literal("get_states"),
  ]),
  domain: Type.Optional(
    Type.String({ description: "Service domain (light, switch, climate)" }),
  ),
  service: Type.Optional(
    Type.String({ description: "Service name (turn_on, turn_off, toggle)" }),
  ),
  entity_id: Type.Optional(
    Type.Union([Type.String(), Type.Array(Type.String())]),
  ),
  data: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  haUrl: Type.Optional(Type.String()),
  haToken: Type.Optional(Type.String()),
});

function createHomeAssistantTool(): AnyAgentTool {
  return {
    label: "Home Assistant",
    name: "home_assistant",
    description:
      "Control Home Assistant smart home devices. Can turn on/off lights, switches, get device states, call any HA service.",
    parameters: HomeAssistantSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });

      const haUrl =
        readStringParam(params, "haUrl") ??
        process.env.HA_URL ??
        "http://192.168.178.26:8123";
      const haToken =
        readStringParam(params, "haToken") ?? process.env.HA_TOKEN;

      if (!haToken) {
        throw new Error(
          "HA_TOKEN environment variable or haToken parameter required",
        );
      }

      const headers = {
        Authorization: `Bearer ${haToken}`,
        "Content-Type": "application/json",
      };

      if (action === "get_state") {
        const entityId = params.entity_id;
        if (typeof entityId !== "string" || !entityId.trim()) {
          throw new Error("entity_id required for get_state");
        }
        const res = await fetch(`${haUrl}/api/states/${entityId.trim()}`, {
          headers,
        });
        if (!res.ok) throw new Error(`HA API error: ${res.status}`);
        return jsonResult(await res.json());
      }

      if (action === "get_states") {
        const res = await fetch(`${haUrl}/api/states`, { headers });
        if (!res.ok) throw new Error(`HA API error: ${res.status}`);
        const states = (await res.json()) as Array<{ entity_id: string }>;
        return jsonResult({
          count: states.length,
          domains: [...new Set(states.map((s) => s.entity_id.split(".")[0]))],
          entities: states.slice(0, 50).map((s) => s.entity_id),
        });
      }

      if (action === "call_service") {
        const domain = readStringParam(params, "domain", { required: true });
        const service = readStringParam(params, "service", { required: true });
        const entityId = params.entity_id;
        const data = (params.data as Record<string, unknown>) ?? {};

        const body: Record<string, unknown> = { ...data };
        if (entityId) body.entity_id = entityId;

        const res = await fetch(`${haUrl}/api/services/${domain}/${service}`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`HA API error: ${res.status}`);
        return jsonResult({
          success: true,
          domain,
          service,
          entity_id: entityId ?? null,
        });
      }

      throw new Error(`Unknown action: ${action}`);
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Text-to-Speech Tool (ElevenLabs)
// ─────────────────────────────────────────────────────────────────────────────

const TTSSchema = Type.Object({
  text: Type.String({ description: "Text to convert to speech" }),
  voice: Type.Optional(
    Type.String({
      description:
        "ElevenLabs voice ID (default: Rachel - 21m00Tcm4TlvDq8ikWAM)",
    }),
  ),
  to: Type.Optional(
    Type.String({ description: "Send voice note to this recipient (E.164)" }),
  ),
  provider: Type.Optional(Type.String()),
  gatewayUrl: Type.Optional(Type.String()),
  gatewayToken: Type.Optional(Type.String()),
});

function createTTSTool(): AnyAgentTool {
  return {
    label: "Text to Speech",
    name: "clawdis_tts",
    description:
      "Convert text to speech using ElevenLabs and optionally send as a voice note via WhatsApp/Telegram.",
    parameters: TTSSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const text = readStringParam(params, "text", { required: true });
      const voice = readStringParam(params, "voice") ?? "21m00Tcm4TlvDq8ikWAM"; // Rachel
      const to = readStringParam(params, "to");
      const provider = readStringParam(params, "provider") ?? "whatsapp";

      const apiKey = process.env.ELEVENLABS_API_KEY;
      if (!apiKey) {
        throw new Error("ELEVENLABS_API_KEY environment variable required");
      }

      // Generate audio via ElevenLabs API
      const ttsRes = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${voice}`,
        {
          method: "POST",
          headers: {
            "xi-api-key": apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            text,
            model_id: "eleven_monolingual_v1",
          }),
        },
      );

      if (!ttsRes.ok) {
        throw new Error(`ElevenLabs API error: ${ttsRes.status}`);
      }

      const audioBuffer = Buffer.from(await ttsRes.arrayBuffer());
      const tmpFile = `/tmp/clawdis-tts-${crypto.randomUUID()}.mp3`;
      await fs.writeFile(tmpFile, audioBuffer);

      if (to) {
        // Send as voice note
        const gatewayOpts: GatewayCallOptions = {
          gatewayUrl: readStringParam(params, "gatewayUrl", { trim: false }),
          gatewayToken: readStringParam(params, "gatewayToken", {
            trim: false,
          }),
        };

        const result = (await callGatewayTool("send", gatewayOpts, {
          to,
          message: "",
          provider,
          mediaUrl: `file://${tmpFile}`,
          idempotencyKey: crypto.randomUUID(),
        })) as Record<string, unknown>;

        return jsonResult({ ...result, audioGenerated: true, voice });
      }

      return jsonResult({ audioPath: tmpFile, voice, textLength: text.length });
    },
  };
}

export function createClawdisTools(): AnyAgentTool[] {
  return [
    createBrowserTool(),
    createCanvasTool(),
    createNodesTool(),
    createCronTool(),
    createGatewayTool(),
    createSendMessageTool(),
    createHomeAssistantTool(),
    createTTSTool(),
  ];
}
