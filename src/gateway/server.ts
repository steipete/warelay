import { randomUUID } from "node:crypto";
import fs from "node:fs";
import {
  createServer as createHttpServer,
  type Server as HttpServer,
  type IncomingMessage,
} from "node:http";
import os from "node:os";
import path from "node:path";
import chalk from "chalk";
import { type WebSocket, WebSocketServer } from "ws";
import { lookupContextTokens } from "../agents/context.js";
import {
  DEFAULT_CONTEXT_TOKENS,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
} from "../agents/defaults.js";
import {
  loadModelCatalog,
  type ModelCatalogEntry,
  resetModelCatalogCacheForTest,
} from "../agents/model-catalog.js";
import { resolveConfiguredModelRef } from "../agents/model-selection.js";
import { installSkill } from "../agents/skills-install.js";
import { buildWorkspaceSkillStatus } from "../agents/skills-status.js";
import { DEFAULT_AGENT_WORKSPACE_DIR } from "../agents/workspace.js";
import { normalizeGroupActivation } from "../auto-reply/group-activation.js";
import {
  normalizeThinkLevel,
  normalizeVerboseLevel,
} from "../auto-reply/thinking.js";
import {
  CANVAS_HOST_PATH,
  handleA2uiHttpRequest,
} from "../canvas-host/a2ui.js";
import {
  type CanvasHostHandler,
  type CanvasHostServer,
  createCanvasHostHandler,
  startCanvasHost,
} from "../canvas-host/server.js";
import { createDefaultDeps } from "../cli/deps.js";
import { agentCommand } from "../commands/agent.js";
import { getHealthSnapshot, type HealthSummary } from "../commands/health.js";
import { getStatusSummary } from "../commands/status.js";
import {
  type ClawdisConfig,
  CONFIG_PATH_CLAWDIS,
  isNixMode,
  loadConfig,
  parseConfigJson5,
  readConfigFileSnapshot,
  validateConfigObject,
  writeConfigFile,
} from "../config/config.js";
import {
  loadSessionStore,
  resolveStorePath,
  type SessionEntry,
  saveSessionStore,
} from "../config/sessions.js";
import { runCronIsolatedAgentTurn } from "../cron/isolated-agent.js";
import {
  appendCronRunLog,
  readCronRunLogEntries,
  resolveCronRunLogPath,
} from "../cron/run-log.js";
import { CronService } from "../cron/service.js";
import { resolveCronStorePath } from "../cron/store.js";
import type { CronJob, CronJobCreate, CronJobPatch } from "../cron/types.js";
import {
  monitorDiscordProvider,
  sendMessageDiscord,
} from "../discord/index.js";
import { type DiscordProbe, probeDiscord } from "../discord/probe.js";
import { isVerbose } from "../globals.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { startGatewayBonjourAdvertiser } from "../infra/bonjour.js";
import { startNodeBridgeServer } from "../infra/bridge/server.js";
import { resolveCanvasHostUrl } from "../infra/canvas-host-url.js";
import { GatewayLockError } from "../infra/gateway-lock.js";
import {
  getLastHeartbeatEvent,
  onHeartbeatEvent,
} from "../infra/heartbeat-events.js";
import {
  setHeartbeatsEnabled,
  startHeartbeatRunner,
} from "../infra/heartbeat-runner.js";
import { requestHeartbeatNow } from "../infra/heartbeat-wake.js";
import { getMachineDisplayName } from "../infra/machine-name.js";
import {
  approveNodePairing,
  listNodePairing,
  rejectNodePairing,
  renamePairedNode,
  requestNodePairing,
  verifyNodeToken,
} from "../infra/node-pairing.js";
import { ensureClawdisCliOnPath } from "../infra/path-env.js";
import {
  enqueueSystemEvent,
  isSystemEventContextChanged,
} from "../infra/system-events.js";
import {
  listSystemPresence,
  updateSystemPresence,
  upsertPresence,
} from "../infra/system-presence.js";
import {
  pickPrimaryTailnetIPv4,
  pickPrimaryTailnetIPv6,
} from "../infra/tailnet.js";
import {
  disableTailscaleFunnel,
  disableTailscaleServe,
  enableTailscaleFunnel,
  enableTailscaleServe,
  getTailnetHostname,
} from "../infra/tailscale.js";
import {
  defaultVoiceWakeTriggers,
  loadVoiceWakeConfig,
  setVoiceWakeTriggers,
} from "../infra/voicewake.js";
import {
  WIDE_AREA_DISCOVERY_DOMAIN,
  writeWideAreaBridgeZone,
} from "../infra/widearea-dns.js";
import { rawDataToString } from "../infra/ws.js";
import {
  createSubsystemLogger,
  getChildLogger,
  getResolvedLoggerSettings,
  runtimeForLogger,
} from "../logging.js";
import { setCommandLaneConcurrency } from "../process/command-queue.js";
import { runExec } from "../process/exec.js";
import { monitorWebProvider, webAuthExists } from "../providers/web/index.js";
import { defaultRuntime } from "../runtime.js";
import { monitorTelegramProvider } from "../telegram/monitor.js";
import { probeTelegram, type TelegramProbe } from "../telegram/probe.js";
import { sendMessageTelegram } from "../telegram/send.js";
import { normalizeE164, resolveUserPath } from "../utils.js";
import type { WebProviderStatus } from "../web/auto-reply.js";
import { startWebLoginWithQr, waitForWebLogin } from "../web/login-qr.js";
import { sendMessageWhatsApp } from "../web/outbound.js";
import { getWebAuthAgeMs, logoutWeb, readWebSelfId } from "../web/session.js";
import {
  assertGatewayAuthConfigured,
  authorizeGatewayConnect,
  type ResolvedGatewayAuth,
} from "./auth.js";
import { buildMessageWithAttachments } from "./chat-attachments.js";
import { handleControlUiHttpRequest } from "./control-ui.js";
import {
  applyHookMappings,
  type HookMappingResolved,
  resolveHookMappings,
} from "./hooks-mapping.js";

ensureClawdisCliOnPath();

const DEFAULT_HOOKS_PATH = "/hooks";
const DEFAULT_HOOKS_MAX_BODY_BYTES = 256 * 1024;

type HooksConfigResolved = {
  basePath: string;
  token: string;
  maxBodyBytes: number;
  mappings: HookMappingResolved[];
};

function resolveHooksConfig(cfg: ClawdisConfig): HooksConfigResolved | null {
  if (cfg.hooks?.enabled !== true) return null;
  const token = cfg.hooks?.token?.trim();
  if (!token) {
    throw new Error("hooks.enabled requires hooks.token");
  }
  const rawPath = cfg.hooks?.path?.trim() || DEFAULT_HOOKS_PATH;
  const withSlash = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  const trimmed =
    withSlash.length > 1 ? withSlash.replace(/\/+$/, "") : withSlash;
  if (trimmed === "/") {
    throw new Error("hooks.path may not be '/'");
  }
  const maxBodyBytes =
    cfg.hooks?.maxBodyBytes && cfg.hooks.maxBodyBytes > 0
      ? cfg.hooks.maxBodyBytes
      : DEFAULT_HOOKS_MAX_BODY_BYTES;
  const mappings = resolveHookMappings(cfg.hooks);
  return {
    basePath: trimmed,
    token,
    maxBodyBytes,
    mappings,
  };
}

function extractHookToken(req: IncomingMessage, url: URL): string | undefined {
  const auth =
    typeof req.headers.authorization === "string"
      ? req.headers.authorization.trim()
      : "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    const token = auth.slice(7).trim();
    if (token) return token;
  }
  const headerToken =
    typeof req.headers["x-clawdis-token"] === "string"
      ? req.headers["x-clawdis-token"].trim()
      : "";
  if (headerToken) return headerToken;
  const queryToken = url.searchParams.get("token");
  if (queryToken) return queryToken.trim();
  return undefined;
}

async function readJsonBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  return await new Promise((resolve) => {
    let done = false;
    let total = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      total += chunk.length;
      if (total > maxBytes) {
        done = true;
        resolve({ ok: false, error: "payload too large" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      const raw = Buffer.concat(chunks).toString("utf-8").trim();
      if (!raw) {
        resolve({ ok: true, value: {} });
        return;
      }
      try {
        const parsed = JSON.parse(raw) as unknown;
        resolve({ ok: true, value: parsed });
      } catch (err) {
        resolve({ ok: false, error: String(err) });
      }
    });
    req.on("error", (err) => {
      if (done) return;
      done = true;
      resolve({ ok: false, error: String(err) });
    });
  });
}

function sendJson(
  res: import("node:http").ServerResponse,
  status: number,
  body: unknown,
) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

const log = createSubsystemLogger("gateway");
const logCanvas = log.child("canvas");
const logBridge = log.child("bridge");
const logDiscovery = log.child("discovery");
const logTailscale = log.child("tailscale");
const logProviders = log.child("providers");
const logBrowser = log.child("browser");
const logHealth = log.child("health");
const logCron = log.child("cron");
const logHooks = log.child("hooks");
const logWsControl = log.child("ws");
const logWhatsApp = logProviders.child("whatsapp");
const logTelegram = logProviders.child("telegram");
const logDiscord = logProviders.child("discord");
const canvasRuntime = runtimeForLogger(logCanvas);
const whatsappRuntimeEnv = runtimeForLogger(logWhatsApp);
const telegramRuntimeEnv = runtimeForLogger(logTelegram);
const discordRuntimeEnv = runtimeForLogger(logDiscord);

function resolveBonjourCliPath(): string | undefined {
  const envPath = process.env.CLAWDIS_CLI_PATH?.trim();
  if (envPath) return envPath;

  const isFile = (candidate: string) => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  };

  const execDir = path.dirname(process.execPath);
  const siblingCli = path.join(execDir, "clawdis");
  if (isFile(siblingCli)) return siblingCli;

  const argvPath = process.argv[1];
  if (argvPath && isFile(argvPath)) {
    const base = path.basename(argvPath);
    if (!base.includes("gateway-daemon")) return argvPath;
  }

  const cwd = process.cwd();
  const distCli = path.join(cwd, "dist", "index.js");
  if (isFile(distCli)) return distCli;
  const binCli = path.join(cwd, "bin", "clawdis.js");
  if (isFile(binCli)) return binCli;

  return undefined;
}

let stopBrowserControlServerIfStarted: (() => Promise<void>) | null = null;

async function startBrowserControlServerIfEnabled(): Promise<void> {
  if (process.env.CLAWDIS_SKIP_BROWSER_CONTROL_SERVER === "1") return;
  // Lazy import: keeps startup fast, but still bundles for the embedded
  // gateway (bun --compile) via the static specifier path.
  const override = process.env.CLAWDIS_BROWSER_CONTROL_MODULE?.trim();
  const mod = override
    ? await import(override)
    : await import("../browser/server.js");
  stopBrowserControlServerIfStarted = mod.stopBrowserControlServer;
  await mod.startBrowserControlServerFromConfig();
}

type GatewayModelChoice = ModelCatalogEntry;

// Test-only escape hatch: model catalog is cached at module scope for the
// process lifetime, which is fine for the real gateway daemon, but makes
// isolated unit tests harder. Keep this intentionally obscure.
export function __resetModelCatalogCacheForTest() {
  resetModelCatalogCacheForTest();
}

async function loadGatewayModelCatalog(): Promise<GatewayModelChoice[]> {
  return await loadModelCatalog({ config: loadConfig() });
}

import {
  type ConnectParams,
  ErrorCodes,
  type ErrorShape,
  errorShape,
  formatValidationErrors,
  PROTOCOL_VERSION,
  type RequestFrame,
  type SessionsCompactParams,
  type SessionsDeleteParams,
  type SessionsListParams,
  type SessionsPatchParams,
  type SessionsResetParams,
  type Snapshot,
  validateAgentParams,
  validateChatAbortParams,
  validateChatHistoryParams,
  validateChatSendParams,
  validateConfigGetParams,
  validateConfigSetParams,
  validateConnectParams,
  validateCronAddParams,
  validateCronListParams,
  validateCronRemoveParams,
  validateCronRunParams,
  validateCronRunsParams,
  validateCronStatusParams,
  validateCronUpdateParams,
  validateModelsListParams,
  validateNodeDescribeParams,
  validateNodeInvokeParams,
  validateNodeListParams,
  validateNodePairApproveParams,
  validateNodePairListParams,
  validateNodePairRejectParams,
  validateNodePairRequestParams,
  validateNodePairVerifyParams,
  validateNodeRenameParams,
  validateProvidersStatusParams,
  validateRequestFrame,
  validateSendParams,
  validateSessionsCompactParams,
  validateSessionsDeleteParams,
  validateSessionsListParams,
  validateSessionsPatchParams,
  validateSessionsResetParams,
  validateSkillsInstallParams,
  validateSkillsStatusParams,
  validateSkillsUpdateParams,
  validateWakeParams,
  validateWebLoginStartParams,
  validateWebLoginWaitParams,
} from "./protocol/index.js";
import { DEFAULT_WS_SLOW_MS, getGatewayWsLogStyle } from "./ws-logging.js";

type Client = {
  socket: WebSocket;
  connect: ConnectParams;
  connId: string;
  presenceKey?: string;
};

function formatBonjourInstanceName(displayName: string) {
  const trimmed = displayName.trim();
  if (!trimmed) return "Clawdis";
  if (/clawdis/i.test(trimmed)) return trimmed;
  return `${trimmed} (Clawdis)`;
}

async function resolveTailnetDnsHint(): Promise<string | undefined> {
  const envRaw = process.env.CLAWDIS_TAILNET_DNS?.trim();
  const env = envRaw && envRaw.length > 0 ? envRaw.replace(/\.$/, "") : "";
  if (env) return env;

  const exec: typeof runExec = (command, args) =>
    runExec(command, args, { timeoutMs: 1500, maxBuffer: 200_000 });
  try {
    return await getTailnetHostname(exec);
  } catch {
    return undefined;
  }
}

type GatewaySessionsDefaults = {
  model: string | null;
  contextTokens: number | null;
};

type GatewaySessionRow = {
  key: string;
  kind: "direct" | "group" | "global" | "unknown";
  updatedAt: number | null;
  sessionId?: string;
  systemSent?: boolean;
  abortedLastRun?: boolean;
  thinkingLevel?: string;
  verboseLevel?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  model?: string;
  contextTokens?: number;
};

type SessionsListResult = {
  ts: number;
  path: string;
  count: number;
  defaults: GatewaySessionsDefaults;
  sessions: GatewaySessionRow[];
};

type SessionsPatchResult = {
  ok: true;
  path: string;
  key: string;
  entry: SessionEntry;
};

const METHODS = [
  "health",
  "providers.status",
  "status",
  "config.get",
  "config.set",
  "models.list",
  "skills.status",
  "skills.install",
  "skills.update",
  "voicewake.get",
  "voicewake.set",
  "sessions.list",
  "sessions.patch",
  "sessions.reset",
  "sessions.delete",
  "sessions.compact",
  "last-heartbeat",
  "set-heartbeats",
  "wake",
  "node.pair.request",
  "node.pair.list",
  "node.pair.approve",
  "node.pair.reject",
  "node.pair.verify",
  "node.rename",
  "node.list",
  "node.describe",
  "node.invoke",
  "cron.list",
  "cron.status",
  "cron.add",
  "cron.update",
  "cron.remove",
  "cron.run",
  "cron.runs",
  "system-presence",
  "system-event",
  "send",
  "agent",
  "web.login.start",
  "web.login.wait",
  "web.logout",
  "telegram.logout",
  // WebChat WebSocket-native chat methods
  "chat.history",
  "chat.abort",
  "chat.send",
];

const EVENTS = [
  "agent",
  "chat",
  "presence",
  "tick",
  "shutdown",
  "health",
  "heartbeat",
  "cron",
  "node.pair.requested",
  "node.pair.resolved",
  "voicewake.changed",
];

export type GatewayServer = {
  close: (opts?: {
    reason?: string;
    restartExpectedMs?: number | null;
  }) => Promise<void>;
};

export type GatewayServerOptions = {
  /**
   * Bind address policy for the Gateway WebSocket/HTTP server.
   * - loopback: 127.0.0.1
   * - lan: 0.0.0.0
   * - tailnet: bind only to the Tailscale IPv4 address (100.64.0.0/10)
   * - auto: prefer tailnet, else LAN
   */
  bind?: import("../config/config.js").BridgeBindMode;
  /**
   * Advanced override for the bind host, bypassing bind resolution.
   * Prefer `bind` unless you really need a specific address.
   */
  host?: string;
  /**
   * If false, do not serve the browser Control UI under /ui/.
   * Default: config `gateway.controlUi.enabled` (or true when absent).
   */
  controlUiEnabled?: boolean;
  /**
   * Override gateway auth configuration (merges with config).
   */
  auth?: import("../config/config.js").GatewayAuthConfig;
  /**
   * Override gateway Tailscale exposure configuration (merges with config).
   */
  tailscale?: import("../config/config.js").GatewayTailscaleConfig;
  /**
   * Test-only: allow canvas host startup even when NODE_ENV/VITEST would disable it.
   */
  allowCanvasHostInTests?: boolean;
};

function isLoopbackAddress(ip: string | undefined): boolean {
  if (!ip) return false;
  if (ip === "127.0.0.1") return true;
  if (ip.startsWith("127.")) return true;
  if (ip === "::1") return true;
  if (ip.startsWith("::ffff:127.")) return true;
  return false;
}

function resolveGatewayBindHost(
  bind: import("../config/config.js").BridgeBindMode | undefined,
): string | null {
  const mode = bind ?? "loopback";
  if (mode === "loopback") return "127.0.0.1";
  if (mode === "lan") return "0.0.0.0";
  if (mode === "tailnet") return pickPrimaryTailnetIPv4() ?? null;
  if (mode === "auto") return pickPrimaryTailnetIPv4() ?? "0.0.0.0";
  return "127.0.0.1";
}

function isLoopbackHost(host: string): boolean {
  return isLoopbackAddress(host);
}

let presenceVersion = 1;
let healthVersion = 1;
let healthCache: HealthSummary | null = null;
let healthRefresh: Promise<HealthSummary> | null = null;
let broadcastHealthUpdate: ((snap: HealthSummary) => void) | null = null;

function buildSnapshot(): Snapshot {
  const presence = listSystemPresence();
  const uptimeMs = Math.round(process.uptime() * 1000);
  // Health is async; caller should await getHealthSnapshot and replace later if needed.
  const emptyHealth: unknown = {};
  return {
    presence,
    health: emptyHealth,
    stateVersion: { presence: presenceVersion, health: healthVersion },
    uptimeMs,
  };
}

const MAX_PAYLOAD_BYTES = 512 * 1024; // cap incoming frame size
const MAX_BUFFERED_BYTES = 1.5 * 1024 * 1024; // per-connection send buffer limit

const MAX_CHAT_HISTORY_MESSAGES_BYTES = 6 * 1024 * 1024; // keep history responses comfortably under client WS limits
const HANDSHAKE_TIMEOUT_MS = 10_000;
const TICK_INTERVAL_MS = 30_000;
const HEALTH_REFRESH_INTERVAL_MS = 60_000;
const DEDUPE_TTL_MS = 5 * 60_000;
const DEDUPE_MAX = 1000;
const LOG_VALUE_LIMIT = 240;

type DedupeEntry = {
  ts: number;
  ok: boolean;
  payload?: unknown;
  error?: ErrorShape;
};

const getGatewayToken = () => process.env.CLAWDIS_GATEWAY_TOKEN;

function formatForLog(value: unknown): string {
  try {
    if (value instanceof Error) {
      const parts: string[] = [];
      if (value.name) parts.push(value.name);
      if (value.message) parts.push(value.message);
      const code =
        "code" in value &&
        (typeof value.code === "string" || typeof value.code === "number")
          ? String(value.code)
          : "";
      if (code) parts.push(`code=${code}`);
      const combined = parts.filter(Boolean).join(": ").trim();
      if (combined) {
        return combined.length > LOG_VALUE_LIMIT
          ? `${combined.slice(0, LOG_VALUE_LIMIT)}...`
          : combined;
      }
    }
    if (value && typeof value === "object") {
      const rec = value as Record<string, unknown>;
      if (typeof rec.message === "string" && rec.message.trim()) {
        const name = typeof rec.name === "string" ? rec.name.trim() : "";
        const code =
          typeof rec.code === "string" || typeof rec.code === "number"
            ? String(rec.code)
            : "";
        const parts = [name, rec.message.trim()].filter(Boolean);
        if (code) parts.push(`code=${code}`);
        const combined = parts.join(": ").trim();
        return combined.length > LOG_VALUE_LIMIT
          ? `${combined.slice(0, LOG_VALUE_LIMIT)}...`
          : combined;
      }
    }
    const str =
      typeof value === "string" || typeof value === "number"
        ? String(value)
        : JSON.stringify(value);
    if (!str) return "";
    return str.length > LOG_VALUE_LIMIT
      ? `${str.slice(0, LOG_VALUE_LIMIT)}...`
      : str;
  } catch {
    return String(value);
  }
}

function compactPreview(input: string, maxLen = 160): string {
  const oneLine = input.replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxLen) return oneLine;
  return `${oneLine.slice(0, Math.max(0, maxLen - 1))}…`;
}

function summarizeAgentEventForWsLog(
  payload: unknown,
): Record<string, unknown> {
  if (!payload || typeof payload !== "object") return {};
  const rec = payload as Record<string, unknown>;
  const runId = typeof rec.runId === "string" ? rec.runId : undefined;
  const stream = typeof rec.stream === "string" ? rec.stream : undefined;
  const seq = typeof rec.seq === "number" ? rec.seq : undefined;
  const data =
    rec.data && typeof rec.data === "object"
      ? (rec.data as Record<string, unknown>)
      : undefined;

  const extra: Record<string, unknown> = {};
  if (runId) extra.run = shortId(runId);
  if (stream) extra.stream = stream;
  if (seq !== undefined) extra.aseq = seq;

  if (!data) return extra;

  if (stream === "assistant") {
    const text = typeof data.text === "string" ? data.text : undefined;
    if (text?.trim()) extra.text = compactPreview(text);
    const mediaUrls = Array.isArray(data.mediaUrls)
      ? data.mediaUrls
      : undefined;
    if (mediaUrls && mediaUrls.length > 0) extra.media = mediaUrls.length;
    return extra;
  }

  if (stream === "tool") {
    const phase = typeof data.phase === "string" ? data.phase : undefined;
    const name = typeof data.name === "string" ? data.name : undefined;
    if (phase || name) extra.tool = `${phase ?? "?"}:${name ?? "?"}`;
    const toolCallId =
      typeof data.toolCallId === "string" ? data.toolCallId : undefined;
    if (toolCallId) extra.call = shortId(toolCallId);
    const meta = typeof data.meta === "string" ? data.meta : undefined;
    if (meta?.trim()) extra.meta = meta;
    if (typeof data.isError === "boolean") extra.err = data.isError;
    return extra;
  }

  if (stream === "job") {
    const state = typeof data.state === "string" ? data.state : undefined;
    if (state) extra.state = state;
    if (data.to === null) extra.to = null;
    else if (typeof data.to === "string") extra.to = data.to;
    if (typeof data.durationMs === "number")
      extra.ms = Math.round(data.durationMs);
    if (typeof data.aborted === "boolean") extra.aborted = data.aborted;
    const error = typeof data.error === "string" ? data.error : undefined;
    if (error?.trim()) extra.error = compactPreview(error, 120);
    return extra;
  }

  const reason = typeof data.reason === "string" ? data.reason : undefined;
  if (reason?.trim()) extra.reason = reason;
  return extra;
}

function normalizeVoiceWakeTriggers(input: unknown): string[] {
  const raw = Array.isArray(input) ? input : [];
  const cleaned = raw
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter((v) => v.length > 0)
    .slice(0, 32)
    .map((v) => v.slice(0, 64));
  return cleaned.length > 0 ? cleaned : defaultVoiceWakeTriggers();
}

function readSessionMessages(
  sessionId: string,
  storePath: string | undefined,
): unknown[] {
  const candidates = resolveSessionTranscriptCandidates(sessionId, storePath);

  const filePath = candidates.find((p) => fs.existsSync(p));
  if (!filePath) return [];

  const lines = fs.readFileSync(filePath, "utf-8").split(/\r?\n/);
  const messages: unknown[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed?.message) {
        messages.push(parsed.message);
      }
    } catch {
      // ignore bad lines
    }
  }
  return messages;
}

function resolveSessionTranscriptCandidates(
  sessionId: string,
  storePath: string | undefined,
): string[] {
  const candidates: string[] = [];
  if (storePath) {
    const dir = path.dirname(storePath);
    candidates.push(path.join(dir, `${sessionId}.jsonl`));
  }
  candidates.push(
    path.join(os.homedir(), ".clawdis", "sessions", `${sessionId}.jsonl`),
  );
  return candidates;
}

function archiveFileOnDisk(filePath: string, reason: string): string {
  const ts = new Date().toISOString().replaceAll(":", "-");
  const archived = `${filePath}.${reason}.${ts}`;
  fs.renameSync(filePath, archived);
  return archived;
}

function jsonUtf8Bytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Buffer.byteLength(String(value), "utf8");
  }
}

function capArrayByJsonBytes<T>(
  items: T[],
  maxBytes: number,
): { items: T[]; bytes: number } {
  if (items.length === 0) return { items, bytes: 2 };
  const parts = items.map((item) => jsonUtf8Bytes(item));
  let bytes = 2 + parts.reduce((a, b) => a + b, 0) + (items.length - 1); // [] + commas
  let start = 0;
  while (bytes > maxBytes && start < items.length - 1) {
    bytes -= parts[start] + 1; // item + comma
    start += 1;
  }
  const next = start > 0 ? items.slice(start) : items;
  return { items: next, bytes };
}

function loadSessionEntry(sessionKey: string) {
  const cfg = loadConfig();
  const sessionCfg = cfg.session;
  const storePath = sessionCfg?.store
    ? resolveStorePath(sessionCfg.store)
    : resolveStorePath(undefined);
  const store = loadSessionStore(storePath);
  const entry = store[sessionKey];
  return { cfg, storePath, store, entry };
}

function classifySessionKey(key: string): GatewaySessionRow["kind"] {
  if (key === "global") return "global";
  if (key.startsWith("group:")) return "group";
  if (key === "unknown") return "unknown";
  return "direct";
}

function getSessionDefaults(cfg: ClawdisConfig): GatewaySessionsDefaults {
  const resolved = resolveConfiguredModelRef({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const contextTokens =
    cfg.agent?.contextTokens ??
    lookupContextTokens(resolved.model) ??
    DEFAULT_CONTEXT_TOKENS;
  return {
    model: resolved.model ?? null,
    contextTokens: contextTokens ?? null,
  };
}

function listSessionsFromStore(params: {
  cfg: ClawdisConfig;
  storePath: string;
  store: Record<string, SessionEntry>;
  opts: SessionsListParams;
}): SessionsListResult {
  const { cfg, storePath, store, opts } = params;
  const now = Date.now();

  const includeGlobal = opts.includeGlobal === true;
  const includeUnknown = opts.includeUnknown === true;
  const activeMinutes =
    typeof opts.activeMinutes === "number" &&
    Number.isFinite(opts.activeMinutes)
      ? Math.max(1, Math.floor(opts.activeMinutes))
      : undefined;

  let sessions = Object.entries(store)
    .filter(([key]) => {
      if (!includeGlobal && key === "global") return false;
      if (!includeUnknown && key === "unknown") return false;
      return true;
    })
    .map(([key, entry]) => {
      const updatedAt = entry?.updatedAt ?? null;
      const input = entry?.inputTokens ?? 0;
      const output = entry?.outputTokens ?? 0;
      const total = entry?.totalTokens ?? input + output;
      return {
        key,
        kind: classifySessionKey(key),
        updatedAt,
        sessionId: entry?.sessionId,
        systemSent: entry?.systemSent,
        abortedLastRun: entry?.abortedLastRun,
        thinkingLevel: entry?.thinkingLevel,
        verboseLevel: entry?.verboseLevel,
        inputTokens: entry?.inputTokens,
        outputTokens: entry?.outputTokens,
        totalTokens: total,
        model: entry?.model,
        contextTokens: entry?.contextTokens,
      } satisfies GatewaySessionRow;
    })
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

  if (activeMinutes !== undefined) {
    const cutoff = now - activeMinutes * 60_000;
    sessions = sessions.filter((s) => (s.updatedAt ?? 0) >= cutoff);
  }

  if (typeof opts.limit === "number" && Number.isFinite(opts.limit)) {
    const limit = Math.max(1, Math.floor(opts.limit));
    sessions = sessions.slice(0, limit);
  }

  return {
    ts: now,
    path: storePath,
    count: sessions.length,
    defaults: getSessionDefaults(cfg),
    sessions,
  };
}

function logWs(
  direction: "in" | "out",
  kind: string,
  meta?: Record<string, unknown>,
) {
  const style = getGatewayWsLogStyle();
  if (!isVerbose()) {
    logWsOptimized(direction, kind, meta);
    return;
  }

  if (style === "compact" || style === "auto") {
    logWsCompact(direction, kind, meta);
    return;
  }

  const now = Date.now();
  const connId = typeof meta?.connId === "string" ? meta.connId : undefined;
  const id = typeof meta?.id === "string" ? meta.id : undefined;
  const method = typeof meta?.method === "string" ? meta.method : undefined;
  const ok = typeof meta?.ok === "boolean" ? meta.ok : undefined;
  const event = typeof meta?.event === "string" ? meta.event : undefined;

  const inflightKey = connId && id ? `${connId}:${id}` : undefined;
  if (direction === "in" && kind === "req" && inflightKey) {
    wsInflightSince.set(inflightKey, now);
  }
  const durationMs =
    direction === "out" && kind === "res" && inflightKey
      ? (() => {
          const startedAt = wsInflightSince.get(inflightKey);
          if (startedAt === undefined) return undefined;
          wsInflightSince.delete(inflightKey);
          return now - startedAt;
        })()
      : undefined;

  const dirArrow = direction === "in" ? "←" : "→";
  const dirColor = direction === "in" ? chalk.greenBright : chalk.cyanBright;
  const prefix = `${chalk.gray("[gws]")} ${dirColor(dirArrow)} ${chalk.bold(kind)}`;

  const headline =
    (kind === "req" || kind === "res") && method
      ? chalk.bold(method)
      : kind === "event" && event
        ? chalk.bold(event)
        : undefined;

  const statusToken =
    kind === "res" && ok !== undefined
      ? ok
        ? chalk.greenBright("✓")
        : chalk.redBright("✗")
      : undefined;

  const durationToken =
    typeof durationMs === "number" ? chalk.dim(`${durationMs}ms`) : undefined;

  const restMeta: string[] = [];
  if (meta) {
    for (const [key, value] of Object.entries(meta)) {
      if (value === undefined) continue;
      if (key === "connId" || key === "id") continue;
      if (key === "method" || key === "ok") continue;
      if (key === "event") continue;
      restMeta.push(`${chalk.dim(key)}=${formatForLog(value)}`);
    }
  }

  const trailing: string[] = [];
  if (connId) {
    trailing.push(`${chalk.dim("conn")}=${chalk.gray(shortId(connId))}`);
  }
  if (id) trailing.push(`${chalk.dim("id")}=${chalk.gray(shortId(id))}`);

  const tokens = [
    prefix,
    statusToken,
    headline,
    durationToken,
    ...restMeta,
    ...trailing,
  ].filter((t): t is string => Boolean(t));

  console.log(tokens.join(" "));
}

type WsInflightEntry = {
  ts: number;
  method?: string;
  meta?: Record<string, unknown>;
};

const wsInflightCompact = new Map<string, WsInflightEntry>();
let wsLastCompactConnId: string | undefined;
const wsInflightOptimized = new Map<string, number>();

function logWsOptimized(
  direction: "in" | "out",
  kind: string,
  meta?: Record<string, unknown>,
) {
  // Keep "normal" mode quiet: only surface errors, slow calls, and parser issues.
  const connId = typeof meta?.connId === "string" ? meta.connId : undefined;
  const id = typeof meta?.id === "string" ? meta.id : undefined;
  const ok = typeof meta?.ok === "boolean" ? meta.ok : undefined;
  const method = typeof meta?.method === "string" ? meta.method : undefined;

  const inflightKey = connId && id ? `${connId}:${id}` : undefined;

  if (direction === "in" && kind === "req" && inflightKey) {
    wsInflightOptimized.set(inflightKey, Date.now());
    if (wsInflightOptimized.size > 2000) wsInflightOptimized.clear();
    return;
  }

  if (kind === "parse-error") {
    const errorMsg =
      typeof meta?.error === "string" ? formatForLog(meta.error) : undefined;
    console.log(
      [
        `${chalk.gray("[gws]")} ${chalk.redBright("✗")} ${chalk.bold("parse-error")}`,
        errorMsg ? `${chalk.dim("error")}=${errorMsg}` : undefined,
        `${chalk.dim("conn")}=${chalk.gray(shortId(connId ?? "?"))}`,
      ]
        .filter((t): t is string => Boolean(t))
        .join(" "),
    );
    return;
  }

  if (direction !== "out" || kind !== "res") return;

  const startedAt = inflightKey
    ? wsInflightOptimized.get(inflightKey)
    : undefined;
  if (inflightKey) wsInflightOptimized.delete(inflightKey);
  const durationMs =
    typeof startedAt === "number" ? Date.now() - startedAt : undefined;

  const shouldLog =
    ok === false ||
    (typeof durationMs === "number" && durationMs >= DEFAULT_WS_SLOW_MS);
  if (!shouldLog) return;

  const statusToken =
    ok === undefined
      ? undefined
      : ok
        ? chalk.greenBright("✓")
        : chalk.redBright("✗");
  const durationToken =
    typeof durationMs === "number" ? chalk.dim(`${durationMs}ms`) : undefined;

  const restMeta: string[] = [];
  if (meta) {
    for (const [key, value] of Object.entries(meta)) {
      if (value === undefined) continue;
      if (key === "connId" || key === "id") continue;
      if (key === "method" || key === "ok") continue;
      restMeta.push(`${chalk.dim(key)}=${formatForLog(value)}`);
    }
  }

  const tokens = [
    `${chalk.gray("[gws]")} ${chalk.yellowBright("⇄")} ${chalk.bold("res")}`,
    statusToken,
    method ? chalk.bold(method) : undefined,
    durationToken,
    ...restMeta,
    connId ? `${chalk.dim("conn")}=${chalk.gray(shortId(connId))}` : undefined,
    id ? `${chalk.dim("id")}=${chalk.gray(shortId(id))}` : undefined,
  ].filter((t): t is string => Boolean(t));

  console.log(tokens.join(" "));
}

function logWsCompact(
  direction: "in" | "out",
  kind: string,
  meta?: Record<string, unknown>,
) {
  const now = Date.now();
  const connId = typeof meta?.connId === "string" ? meta.connId : undefined;
  const id = typeof meta?.id === "string" ? meta.id : undefined;
  const method = typeof meta?.method === "string" ? meta.method : undefined;
  const ok = typeof meta?.ok === "boolean" ? meta.ok : undefined;
  const inflightKey = connId && id ? `${connId}:${id}` : undefined;

  // Pair req/res into a single line (printed on response).
  if (kind === "req" && direction === "in" && inflightKey) {
    wsInflightCompact.set(inflightKey, { ts: now, method, meta });
    return;
  }

  const compactArrow = (() => {
    if (kind === "req" || kind === "res") return "⇄";
    return direction === "in" ? "←" : "→";
  })();
  const arrowColor =
    kind === "req" || kind === "res"
      ? chalk.yellowBright
      : direction === "in"
        ? chalk.greenBright
        : chalk.cyanBright;

  const prefix = `${chalk.gray("[gws]")} ${arrowColor(compactArrow)} ${chalk.bold(kind)}`;

  const statusToken =
    kind === "res" && ok !== undefined
      ? ok
        ? chalk.greenBright("✓")
        : chalk.redBright("✗")
      : undefined;

  const startedAt =
    kind === "res" && direction === "out" && inflightKey
      ? wsInflightCompact.get(inflightKey)?.ts
      : undefined;
  if (kind === "res" && direction === "out" && inflightKey) {
    wsInflightCompact.delete(inflightKey);
  }
  const durationToken =
    typeof startedAt === "number"
      ? chalk.dim(`${now - startedAt}ms`)
      : undefined;

  const headline =
    (kind === "req" || kind === "res") && method
      ? chalk.bold(method)
      : kind === "event" && typeof meta?.event === "string"
        ? chalk.bold(meta.event)
        : undefined;

  const restMeta: string[] = [];
  if (meta) {
    for (const [key, value] of Object.entries(meta)) {
      if (value === undefined) continue;
      if (key === "connId" || key === "id") continue;
      if (key === "method" || key === "ok") continue;
      if (key === "event") continue;
      restMeta.push(`${chalk.dim(key)}=${formatForLog(value)}`);
    }
  }

  const trailing: string[] = [];
  if (connId && connId !== wsLastCompactConnId) {
    trailing.push(`${chalk.dim("conn")}=${chalk.gray(shortId(connId))}`);
    wsLastCompactConnId = connId;
  }
  if (id) trailing.push(`${chalk.dim("id")}=${chalk.gray(shortId(id))}`);

  const tokens = [
    prefix,
    statusToken,
    headline,
    durationToken,
    ...restMeta,
    ...trailing,
  ].filter((t): t is string => Boolean(t));

  console.log(tokens.join(" "));
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function shortId(value: string): string {
  const s = value.trim();
  if (UUID_RE.test(s)) return `${s.slice(0, 8)}…${s.slice(-4)}`;
  if (s.length <= 24) return s;
  return `${s.slice(0, 12)}…${s.slice(-4)}`;
}

const wsInflightSince = new Map<string, number>();

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  const statusValue = (err as { status?: unknown })?.status;
  const codeValue = (err as { code?: unknown })?.code;
  const statusText =
    typeof statusValue === "string" || typeof statusValue === "number"
      ? String(statusValue)
      : undefined;
  const codeText =
    typeof codeValue === "string" || typeof codeValue === "number"
      ? String(codeValue)
      : undefined;
  if (statusText || codeText)
    return `status=${statusText ?? "unknown"} code=${codeText ?? "unknown"}`;
  return JSON.stringify(err, null, 2);
}

async function refreshHealthSnapshot(_opts?: { probe?: boolean }) {
  if (!healthRefresh) {
    healthRefresh = (async () => {
      const snap = await getHealthSnapshot(undefined);
      healthCache = snap;
      healthVersion += 1;
      if (broadcastHealthUpdate) {
        broadcastHealthUpdate(snap);
      }
      return snap;
    })().finally(() => {
      healthRefresh = null;
    });
  }
  return healthRefresh;
}

export async function startGatewayServer(
  port = 18789,
  opts: GatewayServerOptions = {},
): Promise<GatewayServer> {
  const cfgAtStart = loadConfig();
  const bindMode = opts.bind ?? cfgAtStart.gateway?.bind ?? "loopback";
  const bindHost = opts.host ?? resolveGatewayBindHost(bindMode);
  if (!bindHost) {
    throw new Error(
      "gateway bind is tailnet, but no tailnet interface was found; refusing to start gateway",
    );
  }
  const controlUiEnabled =
    opts.controlUiEnabled ?? cfgAtStart.gateway?.controlUi?.enabled ?? true;
  const authBase = cfgAtStart.gateway?.auth ?? {};
  const authOverrides = opts.auth ?? {};
  const authConfig = {
    ...authBase,
    ...authOverrides,
  };
  const tailscaleBase = cfgAtStart.gateway?.tailscale ?? {};
  const tailscaleOverrides = opts.tailscale ?? {};
  const tailscaleConfig = {
    ...tailscaleBase,
    ...tailscaleOverrides,
  };
  const tailscaleMode = tailscaleConfig.mode ?? "off";
  const token = getGatewayToken();
  const password =
    authConfig.password ?? process.env.CLAWDIS_GATEWAY_PASSWORD ?? undefined;
  const authMode: ResolvedGatewayAuth["mode"] =
    authConfig.mode ?? (password ? "password" : token ? "token" : "none");
  const allowTailscale =
    authConfig.allowTailscale ??
    (tailscaleMode === "serve" && authMode !== "password");
  const resolvedAuth: ResolvedGatewayAuth = {
    mode: authMode,
    token,
    password,
    allowTailscale,
  };
  const hooksConfig = resolveHooksConfig(cfgAtStart);
  const canvasHostEnabled =
    process.env.CLAWDIS_SKIP_CANVAS_HOST !== "1" &&
    cfgAtStart.canvasHost?.enabled !== false;
  assertGatewayAuthConfigured(resolvedAuth);
  if (tailscaleMode === "funnel" && authMode !== "password") {
    throw new Error(
      "tailscale funnel requires gateway auth mode=password (set gateway.auth.password or CLAWDIS_GATEWAY_PASSWORD)",
    );
  }
  if (tailscaleMode !== "off" && !isLoopbackHost(bindHost)) {
    throw new Error(
      "tailscale serve/funnel requires gateway bind=loopback (127.0.0.1)",
    );
  }
  if (!isLoopbackHost(bindHost) && authMode === "none") {
    throw new Error(
      `refusing to bind gateway to ${bindHost}:${port} without auth (set gateway.auth or CLAWDIS_GATEWAY_TOKEN)`,
    );
  }

  const normalizeHookHeaders = (req: IncomingMessage) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === "string") {
        headers[key.toLowerCase()] = value;
      } else if (Array.isArray(value) && value.length > 0) {
        headers[key.toLowerCase()] = value.join(", ");
      }
    }
    return headers;
  };

  const normalizeWakePayload = (
    payload: Record<string, unknown>,
  ):
    | { ok: true; value: { text: string; mode: "now" | "next-heartbeat" } }
    | { ok: false; error: string } => {
    const text = typeof payload.text === "string" ? payload.text.trim() : "";
    if (!text) return { ok: false, error: "text required" };
    const mode = payload.mode === "next-heartbeat" ? "next-heartbeat" : "now";
    return { ok: true, value: { text, mode } };
  };

  const normalizeAgentPayload = (
    payload: Record<string, unknown>,
  ):
    | {
        ok: true;
        value: {
          message: string;
          name: string;
          wakeMode: "now" | "next-heartbeat";
          sessionKey: string;
          deliver: boolean;
          channel: "last" | "whatsapp" | "telegram" | "discord";
          to?: string;
          thinking?: string;
          timeoutSeconds?: number;
        };
      }
    | { ok: false; error: string } => {
    const message =
      typeof payload.message === "string" ? payload.message.trim() : "";
    if (!message) return { ok: false, error: "message required" };
    const nameRaw = payload.name;
    const name =
      typeof nameRaw === "string" && nameRaw.trim() ? nameRaw.trim() : "Hook";
    const wakeMode =
      payload.wakeMode === "next-heartbeat" ? "next-heartbeat" : "now";
    const sessionKeyRaw = payload.sessionKey;
    const sessionKey =
      typeof sessionKeyRaw === "string" && sessionKeyRaw.trim()
        ? sessionKeyRaw.trim()
        : `hook:${randomUUID()}`;
    const channelRaw = payload.channel;
    const channel =
      channelRaw === "whatsapp" ||
      channelRaw === "telegram" ||
      channelRaw === "discord" ||
      channelRaw === "last"
        ? channelRaw
        : channelRaw === undefined
          ? "last"
          : null;
    if (channel === null) {
      return {
        ok: false,
        error: "channel must be last|whatsapp|telegram|discord",
      };
    }
    const toRaw = payload.to;
    const to =
      typeof toRaw === "string" && toRaw.trim() ? toRaw.trim() : undefined;
    const deliver = payload.deliver === true;
    const thinkingRaw = payload.thinking;
    const thinking =
      typeof thinkingRaw === "string" && thinkingRaw.trim()
        ? thinkingRaw.trim()
        : undefined;
    const timeoutRaw = payload.timeoutSeconds;
    const timeoutSeconds =
      typeof timeoutRaw === "number" &&
      Number.isFinite(timeoutRaw) &&
      timeoutRaw > 0
        ? Math.floor(timeoutRaw)
        : undefined;
    return {
      ok: true,
      value: {
        message,
        name,
        wakeMode,
        sessionKey,
        deliver,
        channel,
        to,
        thinking,
        timeoutSeconds,
      },
    };
  };

  const dispatchWakeHook = (value: {
    text: string;
    mode: "now" | "next-heartbeat";
  }) => {
    enqueueSystemEvent(value.text);
    if (value.mode === "now") {
      requestHeartbeatNow({ reason: "hook:wake" });
    }
  };

  const dispatchAgentHook = (value: {
    message: string;
    name: string;
    wakeMode: "now" | "next-heartbeat";
    sessionKey: string;
    deliver: boolean;
    channel: "last" | "whatsapp" | "telegram" | "discord";
    to?: string;
    thinking?: string;
    timeoutSeconds?: number;
  }) => {
    const jobId = randomUUID();
    const now = Date.now();
    const job: CronJob = {
      id: jobId,
      name: value.name,
      enabled: true,
      createdAtMs: now,
      updatedAtMs: now,
      schedule: { kind: "at", atMs: now },
      sessionTarget: "isolated",
      wakeMode: value.wakeMode,
      payload: {
        kind: "agentTurn",
        message: value.message,
        thinking: value.thinking,
        timeoutSeconds: value.timeoutSeconds,
        deliver: value.deliver,
        channel: value.channel,
        to: value.to,
      },
      state: { nextRunAtMs: now },
    };

    const runId = randomUUID();
    void (async () => {
      try {
        const cfg = loadConfig();
        const result = await runCronIsolatedAgentTurn({
          cfg,
          deps,
          job,
          message: value.message,
          sessionKey: value.sessionKey,
          lane: "cron",
        });
        const summary =
          result.summary?.trim() || result.error?.trim() || result.status;
        const prefix =
          result.status === "ok"
            ? `Hook ${value.name}`
            : `Hook ${value.name} (${result.status})`;
        enqueueSystemEvent(`${prefix}: ${summary}`.trim());
        if (value.wakeMode === "now") {
          requestHeartbeatNow({ reason: `hook:${jobId}` });
        }
      } catch (err) {
        logHooks.warn(`hook agent failed: ${String(err)}`);
        enqueueSystemEvent(`Hook ${value.name} (error): ${String(err)}`);
        if (value.wakeMode === "now") {
          requestHeartbeatNow({ reason: `hook:${jobId}:error` });
        }
      }
    })();

    return runId;
  };
  let canvasHost: CanvasHostHandler | null = null;
  let canvasHostServer: CanvasHostServer | null = null;
  if (canvasHostEnabled) {
    try {
      const handler = await createCanvasHostHandler({
        runtime: canvasRuntime,
        rootDir: cfgAtStart.canvasHost?.root,
        basePath: CANVAS_HOST_PATH,
        allowInTests: opts.allowCanvasHostInTests,
      });
      if (handler.rootDir) {
        canvasHost = handler;
        logCanvas.info(
          `canvas host mounted at http://${bindHost}:${port}${CANVAS_HOST_PATH}/ (root ${handler.rootDir})`,
        );
      }
    } catch (err) {
      logCanvas.warn(`canvas host failed to start: ${String(err)}`);
    }
  }

  const handleHooksRequest = async (
    req: IncomingMessage,
    res: import("node:http").ServerResponse,
  ): Promise<boolean> => {
    if (!hooksConfig) return false;
    const url = new URL(req.url ?? "/", `http://${bindHost}:${port}`);
    const basePath = hooksConfig.basePath;
    if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) {
      return false;
    }

    const token = extractHookToken(req, url);
    if (!token || token !== hooksConfig.token) {
      res.statusCode = 401;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Unauthorized");
      return true;
    }

    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "POST");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Method Not Allowed");
      return true;
    }

    const subPath = url.pathname.slice(basePath.length).replace(/^\/+/, "");
    if (!subPath) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Not Found");
      return true;
    }

    const body = await readJsonBody(req, hooksConfig.maxBodyBytes);
    if (!body.ok) {
      const status = body.error === "payload too large" ? 413 : 400;
      sendJson(res, status, { ok: false, error: body.error });
      return true;
    }

    const payload =
      typeof body.value === "object" && body.value !== null ? body.value : {};
    const headers = normalizeHookHeaders(req);

    if (subPath === "wake") {
      const normalized = normalizeWakePayload(
        payload as Record<string, unknown>,
      );
      if (!normalized.ok) {
        sendJson(res, 400, { ok: false, error: normalized.error });
        return true;
      }
      dispatchWakeHook(normalized.value);
      sendJson(res, 200, { ok: true, mode: normalized.value.mode });
      return true;
    }

    if (subPath === "agent") {
      const normalized = normalizeAgentPayload(
        payload as Record<string, unknown>,
      );
      if (!normalized.ok) {
        sendJson(res, 400, { ok: false, error: normalized.error });
        return true;
      }
      const runId = dispatchAgentHook(normalized.value);
      sendJson(res, 202, { ok: true, runId });
      return true;
    }

    if (hooksConfig.mappings.length > 0) {
      try {
        const mapped = await applyHookMappings(hooksConfig.mappings, {
          payload: payload as Record<string, unknown>,
          headers,
          url,
          path: subPath,
        });
        if (mapped) {
          if (!mapped.ok) {
            sendJson(res, 400, { ok: false, error: mapped.error });
            return true;
          }
          if (mapped.action.kind === "wake") {
            dispatchWakeHook({
              text: mapped.action.text,
              mode: mapped.action.mode,
            });
            sendJson(res, 200, { ok: true, mode: mapped.action.mode });
            return true;
          }
          const runId = dispatchAgentHook({
            message: mapped.action.message,
            name: mapped.action.name ?? "Hook",
            wakeMode: mapped.action.wakeMode,
            sessionKey: mapped.action.sessionKey ?? `hook:${randomUUID()}`,
            deliver: mapped.action.deliver === true,
            channel: mapped.action.channel ?? "last",
            to: mapped.action.to,
            thinking: mapped.action.thinking,
            timeoutSeconds: mapped.action.timeoutSeconds,
          });
          sendJson(res, 202, { ok: true, runId });
          return true;
        }
      } catch (err) {
        logHooks.warn(`hook mapping failed: ${String(err)}`);
        sendJson(res, 500, { ok: false, error: "hook mapping failed" });
        return true;
      }
    }

    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Not Found");
    return true;
  };

  const httpServer: HttpServer = createHttpServer((req, res) => {
    // Don't interfere with WebSocket upgrades; ws handles the 'upgrade' event.
    if (String(req.headers.upgrade ?? "").toLowerCase() === "websocket") return;

    void (async () => {
      if (await handleHooksRequest(req, res)) return;
      if (canvasHost) {
        if (await handleA2uiHttpRequest(req, res)) return;
        if (await canvasHost.handleHttpRequest(req, res)) return;
      }
      if (controlUiEnabled) {
        if (handleControlUiHttpRequest(req, res)) return;
      }

      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Not Found");
    })().catch((err) => {
      res.statusCode = 500;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(String(err));
    });
  });
  let bonjourStop: (() => Promise<void>) | null = null;
  let bridge: Awaited<ReturnType<typeof startNodeBridgeServer>> | null = null;
  const bridgeNodeSubscriptions = new Map<string, Set<string>>();
  const bridgeSessionSubscribers = new Map<string, Set<string>>();
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        httpServer.off("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        httpServer.off("error", onError);
        resolve();
      };
      httpServer.once("error", onError);
      httpServer.once("listening", onListening);
      httpServer.listen(port, bindHost);
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE") {
      throw new GatewayLockError(
        `another gateway instance is already listening on ws://${bindHost}:${port}`,
        err,
      );
    }
    throw new GatewayLockError(
      `failed to bind gateway socket on ws://${bindHost}:${port}: ${String(err)}`,
      err,
    );
  }

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_PAYLOAD_BYTES,
  });
  httpServer.on("upgrade", (req, socket, head) => {
    if (canvasHost?.handleUpgrade(req, socket, head)) return;
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });
  let whatsappAbort: AbortController | null = null;
  let telegramAbort: AbortController | null = null;
  let discordAbort: AbortController | null = null;
  let whatsappTask: Promise<unknown> | null = null;
  let telegramTask: Promise<unknown> | null = null;
  let discordTask: Promise<unknown> | null = null;
  let whatsappRuntime: WebProviderStatus = {
    running: false,
    connected: false,
    reconnectAttempts: 0,
    lastConnectedAt: null,
    lastDisconnect: null,
    lastMessageAt: null,
    lastEventAt: null,
    lastError: null,
  };
  let telegramRuntime: {
    running: boolean;
    lastStartAt?: number | null;
    lastStopAt?: number | null;
    lastError?: string | null;
    mode?: "webhook" | "polling" | null;
  } = {
    running: false,
    lastStartAt: null,
    lastStopAt: null,
    lastError: null,
    mode: null,
  };
  let discordRuntime: {
    running: boolean;
    lastStartAt?: number | null;
    lastStopAt?: number | null;
    lastError?: string | null;
  } = {
    running: false,
    lastStartAt: null,
    lastStopAt: null,
    lastError: null,
  };
  const clients = new Set<Client>();
  let seq = 0;
  // Track per-run sequence to detect out-of-order/lost agent events.
  const agentRunSeq = new Map<string, number>();
  const dedupe = new Map<string, DedupeEntry>();
  // Map agent sessionId -> {sessionKey, clientRunId} for chat events (WS WebChat clients).
  const chatRunSessions = new Map<
    string,
    { sessionKey: string; clientRunId: string }
  >();
  const chatRunBuffers = new Map<string, string>();
  const chatDeltaSentAt = new Map<string, number>();
  const chatAbortControllers = new Map<
    string,
    { controller: AbortController; sessionId: string; sessionKey: string }
  >();
  setCommandLaneConcurrency("cron", cfgAtStart.cron?.maxConcurrentRuns ?? 1);
  setCommandLaneConcurrency("main", cfgAtStart.agent?.maxConcurrent ?? 1);

  const cronStorePath = resolveCronStorePath(cfgAtStart.cron?.store);
  const cronLogger = getChildLogger({
    module: "cron",
    storePath: cronStorePath,
  });
  const deps = createDefaultDeps();
  const cronEnabled =
    process.env.CLAWDIS_SKIP_CRON !== "1" && cfgAtStart.cron?.enabled !== false;
  const cron = new CronService({
    storePath: cronStorePath,
    cronEnabled,
    enqueueSystemEvent,
    requestHeartbeatNow,
    runIsolatedAgentJob: async ({ job, message }) => {
      const cfg = loadConfig();
      return await runCronIsolatedAgentTurn({
        cfg,
        deps,
        job,
        message,
        sessionKey: `cron:${job.id}`,
        lane: "cron",
      });
    },
    log: cronLogger,
    onEvent: (evt) => {
      broadcast("cron", evt, { dropIfSlow: true });
      if (evt.action === "finished") {
        const logPath = resolveCronRunLogPath({
          storePath: cronStorePath,
          jobId: evt.jobId,
        });
        void appendCronRunLog(logPath, {
          ts: Date.now(),
          jobId: evt.jobId,
          action: "finished",
          status: evt.status,
          error: evt.error,
          summary: evt.summary,
          runAtMs: evt.runAtMs,
          durationMs: evt.durationMs,
          nextRunAtMs: evt.nextRunAtMs,
        }).catch((err) => {
          cronLogger.warn(
            { err: String(err), logPath },
            "cron: run log append failed",
          );
        });
      }
    },
  });

  const updateWhatsAppStatus = (next: WebProviderStatus) => {
    whatsappRuntime = next;
  };

  const startWhatsAppProvider = async () => {
    if (whatsappTask) return;
    const cfg = loadConfig();
    if (cfg.web?.enabled === false) {
      whatsappRuntime = {
        ...whatsappRuntime,
        running: false,
        connected: false,
        lastError: "disabled",
      };
      logWhatsApp.info("skipping provider start (web.enabled=false)");
      return;
    }
    if (!(await webAuthExists())) {
      whatsappRuntime = {
        ...whatsappRuntime,
        running: false,
        connected: false,
        lastError: "not linked",
      };
      logWhatsApp.info("skipping provider start (no linked session)");
      return;
    }
    const { e164, jid } = readWebSelfId();
    const identity = e164 ? e164 : jid ? `jid ${jid}` : "unknown";
    logWhatsApp.info(`starting provider (${identity})`);
    whatsappAbort = new AbortController();
    whatsappRuntime = {
      ...whatsappRuntime,
      running: true,
      connected: false,
      lastError: null,
    };
    const task = monitorWebProvider(
      isVerbose(),
      undefined,
      true,
      undefined,
      whatsappRuntimeEnv,
      whatsappAbort.signal,
      { statusSink: updateWhatsAppStatus },
    )
      .catch((err) => {
        whatsappRuntime = {
          ...whatsappRuntime,
          lastError: formatError(err),
        };
        logWhatsApp.error(`provider exited: ${formatError(err)}`);
      })
      .finally(() => {
        whatsappAbort = null;
        whatsappTask = null;
        whatsappRuntime = {
          ...whatsappRuntime,
          running: false,
          connected: false,
        };
      });
    whatsappTask = task;
  };

  const stopWhatsAppProvider = async () => {
    if (!whatsappAbort && !whatsappTask) return;
    whatsappAbort?.abort();
    try {
      await whatsappTask;
    } catch {
      // ignore
    }
    whatsappAbort = null;
    whatsappTask = null;
    whatsappRuntime = {
      ...whatsappRuntime,
      running: false,
      connected: false,
    };
  };

  /**
   * Load telegram token with priority: env var > tokenFile > botToken.
   * tokenFile supports secret managers (e.g., agenix).
   */
  const loadTelegramToken = (cfg: ClawdisConfig): string => {
    if (process.env.TELEGRAM_BOT_TOKEN) {
      return process.env.TELEGRAM_BOT_TOKEN.trim();
    }
    if (cfg.telegram?.tokenFile) {
      const filePath = cfg.telegram.tokenFile;
      if (!fs.existsSync(filePath)) {
        logTelegram.info(`telegram tokenFile not found: ${filePath}`);
        return "";
      }
      try {
        return fs.readFileSync(filePath, "utf-8").trim();
      } catch (err) {
        logTelegram.info(`failed to read telegram tokenFile: ${String(err)}`);
        return "";
      }
    }
    return cfg.telegram?.botToken?.trim() ?? "";
  };

  const startTelegramProvider = async () => {
    if (telegramTask) return;
    const cfg = loadConfig();
    if (cfg.telegram?.enabled === false) {
      telegramRuntime = {
        ...telegramRuntime,
        running: false,
        lastError: "disabled",
      };
      logTelegram.info("skipping provider start (telegram.enabled=false)");
      return;
    }
    const telegramToken = loadTelegramToken(cfg);
    if (!telegramToken.trim()) {
      telegramRuntime = {
        ...telegramRuntime,
        running: false,
        lastError: "not configured",
      };
      logTelegram.info(
        "skipping provider start (no TELEGRAM_BOT_TOKEN/config)",
      );
      return;
    }
    let telegramBotLabel = "";
    try {
      const probe = await probeTelegram(
        telegramToken.trim(),
        2500,
        cfg.telegram?.proxy,
      );
      const username = probe.ok ? probe.bot?.username?.trim() : null;
      if (username) telegramBotLabel = ` (@${username})`;
    } catch (err) {
      if (isVerbose()) {
        logTelegram.debug(`bot probe failed: ${String(err)}`);
      }
    }
    logTelegram.info(`starting provider${telegramBotLabel}`);
    telegramAbort = new AbortController();
    telegramRuntime = {
      ...telegramRuntime,
      running: true,
      lastStartAt: Date.now(),
      lastError: null,
      mode: cfg.telegram?.webhookUrl ? "webhook" : "polling",
    };
    const task = monitorTelegramProvider({
      token: telegramToken.trim(),
      runtime: telegramRuntimeEnv,
      abortSignal: telegramAbort.signal,
      useWebhook: Boolean(cfg.telegram?.webhookUrl),
      webhookUrl: cfg.telegram?.webhookUrl,
      webhookSecret: cfg.telegram?.webhookSecret,
      webhookPath: cfg.telegram?.webhookPath,
    })
      .catch((err) => {
        telegramRuntime = {
          ...telegramRuntime,
          lastError: formatError(err),
        };
        logTelegram.error(`provider exited: ${formatError(err)}`);
      })
      .finally(() => {
        telegramAbort = null;
        telegramTask = null;
        telegramRuntime = {
          ...telegramRuntime,
          running: false,
          lastStopAt: Date.now(),
        };
      });
    telegramTask = task;
  };

  const stopTelegramProvider = async () => {
    if (!telegramAbort && !telegramTask) return;
    telegramAbort?.abort();
    try {
      await telegramTask;
    } catch {
      // ignore
    }
    telegramAbort = null;
    telegramTask = null;
    telegramRuntime = {
      ...telegramRuntime,
      running: false,
      lastStopAt: Date.now(),
    };
  };

  const startDiscordProvider = async () => {
    if (discordTask) return;
    const cfg = loadConfig();
    if (cfg.discord?.enabled === false) {
      discordRuntime = {
        ...discordRuntime,
        running: false,
        lastError: "disabled",
      };
      logDiscord.info("skipping provider start (discord.enabled=false)");
      return;
    }
    const discordToken =
      process.env.DISCORD_BOT_TOKEN ?? cfg.discord?.token ?? "";
    if (!discordToken.trim()) {
      discordRuntime = {
        ...discordRuntime,
        running: false,
        lastError: "not configured",
      };
      logDiscord.info("skipping provider start (no DISCORD_BOT_TOKEN/config)");
      return;
    }
    let discordBotLabel = "";
    try {
      const probe = await probeDiscord(discordToken.trim(), 2500);
      const username = probe.ok ? probe.bot?.username?.trim() : null;
      if (username) discordBotLabel = ` (@${username})`;
    } catch (err) {
      if (isVerbose()) {
        logDiscord.debug(`bot probe failed: ${String(err)}`);
      }
    }
    logDiscord.info(`starting provider${discordBotLabel}`);
    discordAbort = new AbortController();
    discordRuntime = {
      ...discordRuntime,
      running: true,
      lastStartAt: Date.now(),
      lastError: null,
    };
    const task = monitorDiscordProvider({
      token: discordToken.trim(),
      runtime: discordRuntimeEnv,
      abortSignal: discordAbort.signal,
      allowFrom: cfg.discord?.allowFrom,
      guildAllowFrom: cfg.discord?.guildAllowFrom,
      requireMention: cfg.discord?.requireMention,
      mediaMaxMb: cfg.discord?.mediaMaxMb,
    })
      .catch((err) => {
        discordRuntime = {
          ...discordRuntime,
          lastError: formatError(err),
        };
        logDiscord.error(`provider exited: ${formatError(err)}`);
      })
      .finally(() => {
        discordAbort = null;
        discordTask = null;
        discordRuntime = {
          ...discordRuntime,
          running: false,
          lastStopAt: Date.now(),
        };
      });
    discordTask = task;
  };

  const stopDiscordProvider = async () => {
    if (!discordAbort && !discordTask) return;
    discordAbort?.abort();
    try {
      await discordTask;
    } catch {
      // ignore
    }
    discordAbort = null;
    discordTask = null;
    discordRuntime = {
      ...discordRuntime,
      running: false,
      lastStopAt: Date.now(),
    };
  };

  const startProviders = async () => {
    await startWhatsAppProvider();
    await startDiscordProvider();
    await startTelegramProvider();
  };

  const broadcast = (
    event: string,
    payload: unknown,
    opts?: {
      dropIfSlow?: boolean;
      stateVersion?: { presence?: number; health?: number };
    },
  ) => {
    const eventSeq = ++seq;
    const frame = JSON.stringify({
      type: "event",
      event,
      payload,
      seq: eventSeq,
      stateVersion: opts?.stateVersion,
    });
    const logMeta: Record<string, unknown> = {
      event,
      seq: eventSeq,
      clients: clients.size,
      dropIfSlow: opts?.dropIfSlow,
      presenceVersion: opts?.stateVersion?.presence,
      healthVersion: opts?.stateVersion?.health,
    };
    if (event === "agent") {
      Object.assign(logMeta, summarizeAgentEventForWsLog(payload));
    }
    logWs("out", "event", logMeta);
    for (const c of clients) {
      const slow = c.socket.bufferedAmount > MAX_BUFFERED_BYTES;
      if (slow && opts?.dropIfSlow) continue;
      if (slow) {
        try {
          c.socket.close(1008, "slow consumer");
        } catch {
          /* ignore */
        }
        continue;
      }
      try {
        c.socket.send(frame);
      } catch {
        /* ignore */
      }
    }
  };

  const wideAreaDiscoveryEnabled =
    cfgAtStart.discovery?.wideArea?.enabled === true;

  const bridgeEnabled = (() => {
    if (cfgAtStart.bridge?.enabled !== undefined)
      return cfgAtStart.bridge.enabled === true;
    return process.env.CLAWDIS_BRIDGE_ENABLED !== "0";
  })();

  const bridgePort = (() => {
    if (
      typeof cfgAtStart.bridge?.port === "number" &&
      cfgAtStart.bridge.port > 0
    ) {
      return cfgAtStart.bridge.port;
    }
    if (process.env.CLAWDIS_BRIDGE_PORT !== undefined) {
      const parsed = Number.parseInt(process.env.CLAWDIS_BRIDGE_PORT, 10);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 18790;
    }
    return 18790;
  })();

  const bridgeHost = (() => {
    // Back-compat: allow an env var override when no bind policy is configured.
    if (cfgAtStart.bridge?.bind === undefined) {
      const env = process.env.CLAWDIS_BRIDGE_HOST?.trim();
      if (env) return env;
    }

    const bind =
      cfgAtStart.bridge?.bind ?? (wideAreaDiscoveryEnabled ? "tailnet" : "lan");
    if (bind === "loopback") return "127.0.0.1";
    if (bind === "lan") return "0.0.0.0";

    const tailnetIPv4 = pickPrimaryTailnetIPv4();
    const tailnetIPv6 = pickPrimaryTailnetIPv6();
    if (bind === "tailnet") {
      return tailnetIPv4 ?? tailnetIPv6 ?? null;
    }
    if (bind === "auto") {
      return tailnetIPv4 ?? tailnetIPv6 ?? "0.0.0.0";
    }
    return "0.0.0.0";
  })();

  const canvasHostPort = (() => {
    const configured = cfgAtStart.canvasHost?.port;
    if (typeof configured === "number" && configured > 0) return configured;
    return 18793;
  })();

  if (canvasHostEnabled && bridgeEnabled && bridgeHost) {
    try {
      const started = await startCanvasHost({
        runtime: canvasRuntime,
        rootDir: cfgAtStart.canvasHost?.root,
        port: canvasHostPort,
        listenHost: bridgeHost,
        allowInTests: opts.allowCanvasHostInTests,
      });
      if (started.port > 0) {
        canvasHostServer = started;
      }
    } catch (err) {
      logCanvas.warn(
        `failed to start on ${bridgeHost}:${canvasHostPort}: ${String(err)}`,
      );
    }
  }

  const bridgeSubscribe = (nodeId: string, sessionKey: string) => {
    const normalizedNodeId = nodeId.trim();
    const normalizedSessionKey = sessionKey.trim();
    if (!normalizedNodeId || !normalizedSessionKey) return;

    let nodeSet = bridgeNodeSubscriptions.get(normalizedNodeId);
    if (!nodeSet) {
      nodeSet = new Set<string>();
      bridgeNodeSubscriptions.set(normalizedNodeId, nodeSet);
    }
    if (nodeSet.has(normalizedSessionKey)) return;
    nodeSet.add(normalizedSessionKey);

    let sessionSet = bridgeSessionSubscribers.get(normalizedSessionKey);
    if (!sessionSet) {
      sessionSet = new Set<string>();
      bridgeSessionSubscribers.set(normalizedSessionKey, sessionSet);
    }
    sessionSet.add(normalizedNodeId);
  };

  const bridgeUnsubscribe = (nodeId: string, sessionKey: string) => {
    const normalizedNodeId = nodeId.trim();
    const normalizedSessionKey = sessionKey.trim();
    if (!normalizedNodeId || !normalizedSessionKey) return;

    const nodeSet = bridgeNodeSubscriptions.get(normalizedNodeId);
    nodeSet?.delete(normalizedSessionKey);
    if (nodeSet?.size === 0) bridgeNodeSubscriptions.delete(normalizedNodeId);

    const sessionSet = bridgeSessionSubscribers.get(normalizedSessionKey);
    sessionSet?.delete(normalizedNodeId);
    if (sessionSet?.size === 0)
      bridgeSessionSubscribers.delete(normalizedSessionKey);
  };

  const bridgeUnsubscribeAll = (nodeId: string) => {
    const normalizedNodeId = nodeId.trim();
    const nodeSet = bridgeNodeSubscriptions.get(normalizedNodeId);
    if (!nodeSet) return;
    for (const sessionKey of nodeSet) {
      const sessionSet = bridgeSessionSubscribers.get(sessionKey);
      sessionSet?.delete(normalizedNodeId);
      if (sessionSet?.size === 0) bridgeSessionSubscribers.delete(sessionKey);
    }
    bridgeNodeSubscriptions.delete(normalizedNodeId);
  };

  const bridgeSendToSession = (
    sessionKey: string,
    event: string,
    payload: unknown,
  ) => {
    const normalizedSessionKey = sessionKey.trim();
    if (!normalizedSessionKey) return;
    const subs = bridgeSessionSubscribers.get(normalizedSessionKey);
    if (!subs || subs.size === 0) return;
    if (!bridge) return;

    const payloadJSON = payload ? JSON.stringify(payload) : null;
    for (const nodeId of subs) {
      bridge.sendEvent({ nodeId, event, payloadJSON });
    }
  };

  const bridgeSendToAllSubscribed = (event: string, payload: unknown) => {
    if (!bridge) return;
    const payloadJSON = payload ? JSON.stringify(payload) : null;
    for (const nodeId of bridgeNodeSubscriptions.keys()) {
      bridge.sendEvent({ nodeId, event, payloadJSON });
    }
  };

  const bridgeSendToAllConnected = (event: string, payload: unknown) => {
    if (!bridge) return;
    const payloadJSON = payload ? JSON.stringify(payload) : null;
    for (const node of bridge.listConnected()) {
      bridge.sendEvent({ nodeId: node.nodeId, event, payloadJSON });
    }
  };

  const broadcastVoiceWakeChanged = (triggers: string[]) => {
    const payload = { triggers };
    broadcast("voicewake.changed", payload, { dropIfSlow: true });
    bridgeSendToAllConnected("voicewake.changed", payload);
  };

  const handleBridgeRequest = async (
    nodeId: string,
    req: { id: string; method: string; paramsJSON?: string | null },
  ): Promise<
    | { ok: true; payloadJSON?: string | null }
    | { ok: false; error: { code: string; message: string; details?: unknown } }
  > => {
    const method = req.method.trim();

    const parseParams = (): Record<string, unknown> => {
      const raw = typeof req.paramsJSON === "string" ? req.paramsJSON : "";
      const trimmed = raw.trim();
      if (!trimmed) return {};
      const parsed = JSON.parse(trimmed) as unknown;
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    };

    try {
      switch (method) {
        case "voicewake.get": {
          const cfg = await loadVoiceWakeConfig();
          return {
            ok: true,
            payloadJSON: JSON.stringify({ triggers: cfg.triggers }),
          };
        }
        case "voicewake.set": {
          const params = parseParams();
          const triggers = normalizeVoiceWakeTriggers(params.triggers);
          const cfg = await setVoiceWakeTriggers(triggers);
          broadcastVoiceWakeChanged(cfg.triggers);
          return {
            ok: true,
            payloadJSON: JSON.stringify({ triggers: cfg.triggers }),
          };
        }
        case "health": {
          const now = Date.now();
          const cached = healthCache;
          if (cached && now - cached.ts < HEALTH_REFRESH_INTERVAL_MS) {
            return { ok: true, payloadJSON: JSON.stringify(cached) };
          }
          const snap = await refreshHealthSnapshot({ probe: false });
          return { ok: true, payloadJSON: JSON.stringify(snap) };
        }
        case "config.get": {
          const params = parseParams();
          if (!validateConfigGetParams(params)) {
            return {
              ok: false,
              error: {
                code: ErrorCodes.INVALID_REQUEST,
                message: `invalid config.get params: ${formatValidationErrors(validateConfigGetParams.errors)}`,
              },
            };
          }
          const snapshot = await readConfigFileSnapshot();
          return { ok: true, payloadJSON: JSON.stringify(snapshot) };
        }
        case "config.set": {
          const params = parseParams();
          if (!validateConfigSetParams(params)) {
            return {
              ok: false,
              error: {
                code: ErrorCodes.INVALID_REQUEST,
                message: `invalid config.set params: ${formatValidationErrors(validateConfigSetParams.errors)}`,
              },
            };
          }
          const rawValue = (params as { raw?: unknown }).raw;
          if (typeof rawValue !== "string") {
            return {
              ok: false,
              error: {
                code: ErrorCodes.INVALID_REQUEST,
                message: "invalid config.set params: raw (string) required",
              },
            };
          }
          const parsedRes = parseConfigJson5(rawValue);
          if (!parsedRes.ok) {
            return {
              ok: false,
              error: {
                code: ErrorCodes.INVALID_REQUEST,
                message: parsedRes.error,
              },
            };
          }
          const validated = validateConfigObject(parsedRes.parsed);
          if (!validated.ok) {
            return {
              ok: false,
              error: {
                code: ErrorCodes.INVALID_REQUEST,
                message: "invalid config",
                details: { issues: validated.issues },
              },
            };
          }
          await writeConfigFile(validated.config);
          return {
            ok: true,
            payloadJSON: JSON.stringify({
              ok: true,
              path: CONFIG_PATH_CLAWDIS,
              config: validated.config,
            }),
          };
        }
        case "models.list": {
          const params = parseParams();
          if (!validateModelsListParams(params)) {
            return {
              ok: false,
              error: {
                code: ErrorCodes.INVALID_REQUEST,
                message: `invalid models.list params: ${formatValidationErrors(validateModelsListParams.errors)}`,
              },
            };
          }
          const models = await loadGatewayModelCatalog();
          return { ok: true, payloadJSON: JSON.stringify({ models }) };
        }
        case "sessions.list": {
          const params = parseParams();
          if (!validateSessionsListParams(params)) {
            return {
              ok: false,
              error: {
                code: ErrorCodes.INVALID_REQUEST,
                message: `invalid sessions.list params: ${formatValidationErrors(validateSessionsListParams.errors)}`,
              },
            };
          }
          const p = params as SessionsListParams;
          const cfg = loadConfig();
          const storePath = resolveStorePath(cfg.session?.store);
          const store = loadSessionStore(storePath);
          const result = listSessionsFromStore({
            cfg,
            storePath,
            store,
            opts: p,
          });
          return { ok: true, payloadJSON: JSON.stringify(result) };
        }
        case "sessions.patch": {
          const params = parseParams();
          if (!validateSessionsPatchParams(params)) {
            return {
              ok: false,
              error: {
                code: ErrorCodes.INVALID_REQUEST,
                message: `invalid sessions.patch params: ${formatValidationErrors(validateSessionsPatchParams.errors)}`,
              },
            };
          }

          const p = params as SessionsPatchParams;
          const key = String(p.key ?? "").trim();
          if (!key) {
            return {
              ok: false,
              error: {
                code: ErrorCodes.INVALID_REQUEST,
                message: "key required",
              },
            };
          }

          const cfg = loadConfig();
          const storePath = resolveStorePath(cfg.session?.store);
          const store = loadSessionStore(storePath);
          const now = Date.now();

          const existing = store[key];
          const next: SessionEntry = existing
            ? {
                ...existing,
                updatedAt: Math.max(existing.updatedAt ?? 0, now),
              }
            : { sessionId: randomUUID(), updatedAt: now };

          if ("thinkingLevel" in p) {
            const raw = p.thinkingLevel;
            if (raw === null) {
              delete next.thinkingLevel;
            } else if (raw !== undefined) {
              const normalized = normalizeThinkLevel(String(raw));
              if (!normalized) {
                return {
                  ok: false,
                  error: {
                    code: ErrorCodes.INVALID_REQUEST,
                    message: `invalid thinkingLevel: ${String(raw)}`,
                  },
                };
              }
              next.thinkingLevel = normalized;
            }
          }

          if ("verboseLevel" in p) {
            const raw = p.verboseLevel;
            if (raw === null) {
              delete next.verboseLevel;
            } else if (raw !== undefined) {
              const normalized = normalizeVerboseLevel(String(raw));
              if (!normalized) {
                return {
                  ok: false,
                  error: {
                    code: ErrorCodes.INVALID_REQUEST,
                    message: `invalid verboseLevel: ${String(raw)}`,
                  },
                };
              }
              next.verboseLevel = normalized;
            }
          }

          if ("groupActivation" in p) {
            const raw = p.groupActivation;
            if (raw === null) {
              delete next.groupActivation;
            } else if (raw !== undefined) {
              const normalized = normalizeGroupActivation(String(raw));
              if (!normalized) {
                return {
                  ok: false,
                  error: {
                    code: ErrorCodes.INVALID_REQUEST,
                    message: `invalid groupActivation: ${String(raw)}`,
                  },
                };
              }
              next.groupActivation = normalized;
            }
          }

          store[key] = next;
          await saveSessionStore(storePath, store);
          const payload: SessionsPatchResult = {
            ok: true,
            path: storePath,
            key,
            entry: next,
          };
          return { ok: true, payloadJSON: JSON.stringify(payload) };
        }
        case "sessions.reset": {
          const params = parseParams();
          if (!validateSessionsResetParams(params)) {
            return {
              ok: false,
              error: {
                code: ErrorCodes.INVALID_REQUEST,
                message: `invalid sessions.reset params: ${formatValidationErrors(validateSessionsResetParams.errors)}`,
              },
            };
          }

          const p = params as SessionsResetParams;
          const key = String(p.key ?? "").trim();
          if (!key) {
            return {
              ok: false,
              error: {
                code: ErrorCodes.INVALID_REQUEST,
                message: "key required",
              },
            };
          }

          const { storePath, store, entry } = loadSessionEntry(key);
          const now = Date.now();
          const next: SessionEntry = {
            sessionId: randomUUID(),
            updatedAt: now,
            systemSent: false,
            abortedLastRun: false,
            thinkingLevel: entry?.thinkingLevel,
            verboseLevel: entry?.verboseLevel,
            model: entry?.model,
            contextTokens: entry?.contextTokens,
            lastChannel: entry?.lastChannel,
            lastTo: entry?.lastTo,
            skillsSnapshot: entry?.skillsSnapshot,
          };
          store[key] = next;
          await saveSessionStore(storePath, store);
          return {
            ok: true,
            payloadJSON: JSON.stringify({ ok: true, key, entry: next }),
          };
        }
        case "sessions.delete": {
          const params = parseParams();
          if (!validateSessionsDeleteParams(params)) {
            return {
              ok: false,
              error: {
                code: ErrorCodes.INVALID_REQUEST,
                message: `invalid sessions.delete params: ${formatValidationErrors(validateSessionsDeleteParams.errors)}`,
              },
            };
          }

          const p = params as SessionsDeleteParams;
          const key = String(p.key ?? "").trim();
          if (!key) {
            return {
              ok: false,
              error: {
                code: ErrorCodes.INVALID_REQUEST,
                message: "key required",
              },
            };
          }

          const deleteTranscript =
            typeof p.deleteTranscript === "boolean" ? p.deleteTranscript : true;

          const { storePath, store, entry } = loadSessionEntry(key);
          const sessionId = entry?.sessionId;
          const existed = Boolean(store[key]);
          if (existed) delete store[key];
          await saveSessionStore(storePath, store);

          const archived: string[] = [];
          if (deleteTranscript && sessionId) {
            for (const candidate of resolveSessionTranscriptCandidates(
              sessionId,
              storePath,
            )) {
              if (!fs.existsSync(candidate)) continue;
              try {
                archived.push(archiveFileOnDisk(candidate, "deleted"));
              } catch {
                // Best-effort; deleting the store entry is the main operation.
              }
            }
          }

          return {
            ok: true,
            payloadJSON: JSON.stringify({
              ok: true,
              key,
              deleted: existed,
              archived,
            }),
          };
        }
        case "sessions.compact": {
          const params = parseParams();
          if (!validateSessionsCompactParams(params)) {
            return {
              ok: false,
              error: {
                code: ErrorCodes.INVALID_REQUEST,
                message: `invalid sessions.compact params: ${formatValidationErrors(validateSessionsCompactParams.errors)}`,
              },
            };
          }

          const p = params as SessionsCompactParams;
          const key = String(p.key ?? "").trim();
          if (!key) {
            return {
              ok: false,
              error: {
                code: ErrorCodes.INVALID_REQUEST,
                message: "key required",
              },
            };
          }

          const maxLines =
            typeof p.maxLines === "number" && Number.isFinite(p.maxLines)
              ? Math.max(1, Math.floor(p.maxLines))
              : 400;

          const { storePath, store, entry } = loadSessionEntry(key);
          const sessionId = entry?.sessionId;
          if (!sessionId) {
            return {
              ok: true,
              payloadJSON: JSON.stringify({
                ok: true,
                key,
                compacted: false,
                reason: "no sessionId",
              }),
            };
          }

          const filePath = resolveSessionTranscriptCandidates(
            sessionId,
            storePath,
          ).find((candidate) => fs.existsSync(candidate));
          if (!filePath) {
            return {
              ok: true,
              payloadJSON: JSON.stringify({
                ok: true,
                key,
                compacted: false,
                reason: "no transcript",
              }),
            };
          }

          const raw = fs.readFileSync(filePath, "utf-8");
          const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
          if (lines.length <= maxLines) {
            return {
              ok: true,
              payloadJSON: JSON.stringify({
                ok: true,
                key,
                compacted: false,
                kept: lines.length,
              }),
            };
          }

          const archived = archiveFileOnDisk(filePath, "bak");
          const keptLines = lines.slice(-maxLines);
          fs.writeFileSync(filePath, `${keptLines.join("\n")}\n`, "utf-8");

          // Token counts no longer match; clear so status + UI reflect reality after the next turn.
          if (store[key]) {
            delete store[key].inputTokens;
            delete store[key].outputTokens;
            delete store[key].totalTokens;
            store[key].updatedAt = Date.now();
            await saveSessionStore(storePath, store);
          }

          return {
            ok: true,
            payloadJSON: JSON.stringify({
              ok: true,
              key,
              compacted: true,
              archived,
              kept: keptLines.length,
            }),
          };
        }
        case "chat.history": {
          const params = parseParams();
          if (!validateChatHistoryParams(params)) {
            return {
              ok: false,
              error: {
                code: ErrorCodes.INVALID_REQUEST,
                message: `invalid chat.history params: ${formatValidationErrors(validateChatHistoryParams.errors)}`,
              },
            };
          }
          const { sessionKey, limit } = params as {
            sessionKey: string;
            limit?: number;
          };
          const { storePath, entry } = loadSessionEntry(sessionKey);
          const sessionId = entry?.sessionId;
          const rawMessages =
            sessionId && storePath
              ? readSessionMessages(sessionId, storePath)
              : [];
          const max = typeof limit === "number" ? limit : 200;
          const sliced =
            rawMessages.length > max ? rawMessages.slice(-max) : rawMessages;
          const capped = capArrayByJsonBytes(
            sliced,
            MAX_CHAT_HISTORY_MESSAGES_BYTES,
          ).items;
          const thinkingLevel =
            entry?.thinkingLevel ??
            loadConfig().agent?.thinkingDefault ??
            "off";
          return {
            ok: true,
            payloadJSON: JSON.stringify({
              sessionKey,
              sessionId,
              messages: capped,
              thinkingLevel,
            }),
          };
        }
        case "chat.abort": {
          const params = parseParams();
          if (!validateChatAbortParams(params)) {
            return {
              ok: false,
              error: {
                code: ErrorCodes.INVALID_REQUEST,
                message: `invalid chat.abort params: ${formatValidationErrors(validateChatAbortParams.errors)}`,
              },
            };
          }

          const { sessionKey, runId } = params as {
            sessionKey: string;
            runId: string;
          };
          const active = chatAbortControllers.get(runId);
          if (!active) {
            return {
              ok: true,
              payloadJSON: JSON.stringify({ ok: true, aborted: false }),
            };
          }
          if (active.sessionKey !== sessionKey) {
            return {
              ok: false,
              error: {
                code: ErrorCodes.INVALID_REQUEST,
                message: "runId does not match sessionKey",
              },
            };
          }

          active.controller.abort();
          chatAbortControllers.delete(runId);
          chatRunBuffers.delete(runId);
          chatDeltaSentAt.delete(runId);
          const current = chatRunSessions.get(active.sessionId);
          if (
            current?.clientRunId === runId &&
            current.sessionKey === sessionKey
          ) {
            chatRunSessions.delete(active.sessionId);
          }

          const payload = {
            runId,
            sessionKey,
            seq: (agentRunSeq.get(active.sessionId) ?? 0) + 1,
            state: "aborted" as const,
          };
          broadcast("chat", payload);
          bridgeSendToSession(sessionKey, "chat", payload);
          return {
            ok: true,
            payloadJSON: JSON.stringify({ ok: true, aborted: true }),
          };
        }
        case "chat.send": {
          const params = parseParams();
          if (!validateChatSendParams(params)) {
            return {
              ok: false,
              error: {
                code: ErrorCodes.INVALID_REQUEST,
                message: `invalid chat.send params: ${formatValidationErrors(validateChatSendParams.errors)}`,
              },
            };
          }

          const p = params as {
            sessionKey: string;
            message: string;
            thinking?: string;
            deliver?: boolean;
            attachments?: Array<{
              type?: string;
              mimeType?: string;
              fileName?: string;
              content?: unknown;
            }>;
            timeoutMs?: number;
            idempotencyKey: string;
          };
          const timeoutMs = Math.min(
            Math.max(p.timeoutMs ?? 30_000, 0),
            30_000,
          );
          const normalizedAttachments =
            p.attachments?.map((a) => ({
              type: typeof a?.type === "string" ? a.type : undefined,
              mimeType:
                typeof a?.mimeType === "string" ? a.mimeType : undefined,
              fileName:
                typeof a?.fileName === "string" ? a.fileName : undefined,
              content:
                typeof a?.content === "string"
                  ? a.content
                  : ArrayBuffer.isView(a?.content)
                    ? Buffer.from(
                        a.content.buffer,
                        a.content.byteOffset,
                        a.content.byteLength,
                      ).toString("base64")
                    : undefined,
            })) ?? [];

          let messageWithAttachments = p.message;
          if (normalizedAttachments.length > 0) {
            try {
              messageWithAttachments = buildMessageWithAttachments(
                p.message,
                normalizedAttachments,
                { maxBytes: 5_000_000 },
              );
            } catch (err) {
              return {
                ok: false,
                error: {
                  code: ErrorCodes.INVALID_REQUEST,
                  message: String(err),
                },
              };
            }
          }

          const { storePath, store, entry } = loadSessionEntry(p.sessionKey);
          const now = Date.now();
          const sessionId = entry?.sessionId ?? randomUUID();
          const sessionEntry: SessionEntry = {
            sessionId,
            updatedAt: now,
            thinkingLevel: entry?.thinkingLevel,
            verboseLevel: entry?.verboseLevel,
            systemSent: entry?.systemSent,
            lastChannel: entry?.lastChannel,
            lastTo: entry?.lastTo,
          };
          const clientRunId = p.idempotencyKey;

          const cached = dedupe.get(`chat:${clientRunId}`);
          if (cached) {
            if (cached.ok) {
              return { ok: true, payloadJSON: JSON.stringify(cached.payload) };
            }
            return {
              ok: false,
              error: cached.error ?? {
                code: ErrorCodes.UNAVAILABLE,
                message: "request failed",
              },
            };
          }

          try {
            const abortController = new AbortController();
            chatAbortControllers.set(clientRunId, {
              controller: abortController,
              sessionId,
              sessionKey: p.sessionKey,
            });
            chatRunSessions.set(sessionId, {
              sessionKey: p.sessionKey,
              clientRunId,
            });

            if (store) {
              store[p.sessionKey] = sessionEntry;
              if (storePath) {
                await saveSessionStore(storePath, store);
              }
            }

            await agentCommand(
              {
                message: messageWithAttachments,
                sessionId,
                thinking: p.thinking,
                deliver: p.deliver,
                timeout: Math.ceil(timeoutMs / 1000).toString(),
                surface: `Node(${nodeId})`,
                abortSignal: abortController.signal,
              },
              defaultRuntime,
              deps,
            );
            const payload = {
              runId: clientRunId,
              status: "ok" as const,
            };
            dedupe.set(`chat:${clientRunId}`, {
              ts: Date.now(),
              ok: true,
              payload,
            });
            return { ok: true, payloadJSON: JSON.stringify(payload) };
          } catch (err) {
            const error = errorShape(ErrorCodes.UNAVAILABLE, String(err));
            const payload = {
              runId: clientRunId,
              status: "error" as const,
              summary: String(err),
            };
            dedupe.set(`chat:${clientRunId}`, {
              ts: Date.now(),
              ok: false,
              payload,
              error,
            });
            return {
              ok: false,
              error: error ?? {
                code: ErrorCodes.UNAVAILABLE,
                message: String(err),
              },
            };
          } finally {
            chatAbortControllers.delete(clientRunId);
          }
        }
        default:
          return {
            ok: false,
            error: {
              code: "FORBIDDEN",
              message: "Method not allowed",
              details: { method },
            },
          };
      }
    } catch (err) {
      return {
        ok: false,
        error: { code: ErrorCodes.INVALID_REQUEST, message: String(err) },
      };
    }
  };

  const handleBridgeEvent = async (
    nodeId: string,
    evt: { event: string; payloadJSON?: string | null },
  ) => {
    switch (evt.event) {
      case "voice.transcript": {
        if (!evt.payloadJSON) return;
        let payload: unknown;
        try {
          payload = JSON.parse(evt.payloadJSON) as unknown;
        } catch {
          return;
        }
        const obj =
          typeof payload === "object" && payload !== null
            ? (payload as Record<string, unknown>)
            : {};
        const text = typeof obj.text === "string" ? obj.text.trim() : "";
        if (!text) return;
        if (text.length > 20_000) return;
        const sessionKeyRaw =
          typeof obj.sessionKey === "string" ? obj.sessionKey.trim() : "";
        const mainKey =
          (loadConfig().session?.mainKey ?? "main").trim() || "main";
        const sessionKey = sessionKeyRaw.length > 0 ? sessionKeyRaw : mainKey;
        const { storePath, store, entry } = loadSessionEntry(sessionKey);
        const now = Date.now();
        const sessionId = entry?.sessionId ?? randomUUID();
        store[sessionKey] = {
          sessionId,
          updatedAt: now,
          thinkingLevel: entry?.thinkingLevel,
          verboseLevel: entry?.verboseLevel,
          systemSent: entry?.systemSent,
          lastChannel: entry?.lastChannel,
          lastTo: entry?.lastTo,
        };
        if (storePath) {
          await saveSessionStore(storePath, store);
        }

        void agentCommand(
          {
            message: text,
            sessionId,
            thinking: "low",
            deliver: false,
            surface: "Node",
          },
          defaultRuntime,
          deps,
        ).catch((err) => {
          logBridge.warn(`agent failed node=${nodeId}: ${formatForLog(err)}`);
        });
        return;
      }
      case "agent.request": {
        if (!evt.payloadJSON) return;
        type AgentDeepLink = {
          message?: string;
          sessionKey?: string | null;
          thinking?: string | null;
          deliver?: boolean;
          to?: string | null;
          channel?: string | null;
          timeoutSeconds?: number | null;
          key?: string | null;
        };
        let link: AgentDeepLink | null = null;
        try {
          link = JSON.parse(evt.payloadJSON) as AgentDeepLink;
        } catch {
          return;
        }
        const message = (link?.message ?? "").trim();
        if (!message) return;
        if (message.length > 20_000) return;

        const channelRaw =
          typeof link?.channel === "string" ? link.channel.trim() : "";
        const channel = channelRaw.toLowerCase();
        const provider =
          channel === "whatsapp" || channel === "telegram"
            ? channel
            : undefined;
        const to =
          typeof link?.to === "string" && link.to.trim()
            ? link.to.trim()
            : undefined;
        const deliver = Boolean(link?.deliver) && Boolean(provider);

        const sessionKeyRaw = (link?.sessionKey ?? "").trim();
        const sessionKey =
          sessionKeyRaw.length > 0 ? sessionKeyRaw : `node-${nodeId}`;
        const { storePath, store, entry } = loadSessionEntry(sessionKey);
        const now = Date.now();
        const sessionId = entry?.sessionId ?? randomUUID();
        store[sessionKey] = {
          sessionId,
          updatedAt: now,
          thinkingLevel: entry?.thinkingLevel,
          verboseLevel: entry?.verboseLevel,
          systemSent: entry?.systemSent,
          lastChannel: entry?.lastChannel,
          lastTo: entry?.lastTo,
        };
        if (storePath) {
          await saveSessionStore(storePath, store);
        }

        void agentCommand(
          {
            message,
            sessionId,
            thinking: link?.thinking ?? undefined,
            deliver,
            to,
            provider,
            timeout:
              typeof link?.timeoutSeconds === "number"
                ? link.timeoutSeconds.toString()
                : undefined,
            surface: "Node",
          },
          defaultRuntime,
          deps,
        ).catch((err) => {
          logBridge.warn(`agent failed node=${nodeId}: ${formatForLog(err)}`);
        });
        return;
      }
      case "chat.subscribe": {
        if (!evt.payloadJSON) return;
        let payload: unknown;
        try {
          payload = JSON.parse(evt.payloadJSON) as unknown;
        } catch {
          return;
        }
        const obj =
          typeof payload === "object" && payload !== null
            ? (payload as Record<string, unknown>)
            : {};
        const sessionKey =
          typeof obj.sessionKey === "string" ? obj.sessionKey.trim() : "";
        if (!sessionKey) return;
        bridgeSubscribe(nodeId, sessionKey);
        return;
      }
      case "chat.unsubscribe": {
        if (!evt.payloadJSON) return;
        let payload: unknown;
        try {
          payload = JSON.parse(evt.payloadJSON) as unknown;
        } catch {
          return;
        }
        const obj =
          typeof payload === "object" && payload !== null
            ? (payload as Record<string, unknown>)
            : {};
        const sessionKey =
          typeof obj.sessionKey === "string" ? obj.sessionKey.trim() : "";
        if (!sessionKey) return;
        bridgeUnsubscribe(nodeId, sessionKey);
        return;
      }
      default:
        return;
    }
  };

  const machineDisplayName = await getMachineDisplayName();
  const canvasHostPortForBridge = canvasHostServer?.port;
  const canvasHostHostForBridge =
    canvasHostServer &&
    bridgeHost &&
    bridgeHost !== "0.0.0.0" &&
    bridgeHost !== "::"
      ? bridgeHost
      : undefined;

  if (bridgeEnabled && bridgePort > 0 && bridgeHost) {
    try {
      const started = await startNodeBridgeServer({
        host: bridgeHost,
        port: bridgePort,
        serverName: machineDisplayName,
        canvasHostPort: canvasHostPortForBridge,
        canvasHostHost: canvasHostHostForBridge,
        onRequest: (nodeId, req) => handleBridgeRequest(nodeId, req),
        onAuthenticated: async (node) => {
          const host = node.displayName?.trim() || node.nodeId;
          const ip = node.remoteIp?.trim();
          const version = node.version?.trim() || "unknown";
          const platform = node.platform?.trim() || undefined;
          const deviceFamily = node.deviceFamily?.trim() || undefined;
          const modelIdentifier = node.modelIdentifier?.trim() || undefined;
          const text = `Node: ${host}${ip ? ` (${ip})` : ""} · app ${version} · last input 0s ago · mode remote · reason node-connected`;
          upsertPresence(node.nodeId, {
            host,
            ip,
            version,
            platform,
            deviceFamily,
            modelIdentifier,
            mode: "remote",
            reason: "node-connected",
            lastInputSeconds: 0,
            instanceId: node.nodeId,
            text,
          });
          presenceVersion += 1;
          broadcast(
            "presence",
            { presence: listSystemPresence() },
            {
              dropIfSlow: true,
              stateVersion: {
                presence: presenceVersion,
                health: healthVersion,
              },
            },
          );

          try {
            const cfg = await loadVoiceWakeConfig();
            started.sendEvent({
              nodeId: node.nodeId,
              event: "voicewake.changed",
              payloadJSON: JSON.stringify({ triggers: cfg.triggers }),
            });
          } catch {
            // Best-effort only.
          }
        },
        onDisconnected: (node) => {
          bridgeUnsubscribeAll(node.nodeId);
          const host = node.displayName?.trim() || node.nodeId;
          const ip = node.remoteIp?.trim();
          const version = node.version?.trim() || "unknown";
          const platform = node.platform?.trim() || undefined;
          const deviceFamily = node.deviceFamily?.trim() || undefined;
          const modelIdentifier = node.modelIdentifier?.trim() || undefined;
          const text = `Node: ${host}${ip ? ` (${ip})` : ""} · app ${version} · last input 0s ago · mode remote · reason node-disconnected`;
          upsertPresence(node.nodeId, {
            host,
            ip,
            version,
            platform,
            deviceFamily,
            modelIdentifier,
            mode: "remote",
            reason: "node-disconnected",
            lastInputSeconds: 0,
            instanceId: node.nodeId,
            text,
          });
          presenceVersion += 1;
          broadcast(
            "presence",
            { presence: listSystemPresence() },
            {
              dropIfSlow: true,
              stateVersion: {
                presence: presenceVersion,
                health: healthVersion,
              },
            },
          );
        },
        onEvent: handleBridgeEvent,
        onPairRequested: (request) => {
          broadcast("node.pair.requested", request, { dropIfSlow: true });
        },
      });
      if (started.port > 0) {
        bridge = started;
        logBridge.info(
          `listening on tcp://${bridgeHost}:${bridge.port} (node)`,
        );
      }
    } catch (err) {
      logBridge.warn(`failed to start: ${String(err)}`);
    }
  } else if (bridgeEnabled && bridgePort > 0 && !bridgeHost) {
    logBridge.warn(
      "bind policy requested tailnet IP, but no tailnet interface was found; refusing to start bridge",
    );
  }

  const tailnetDns = await resolveTailnetDnsHint();

  try {
    const sshPortEnv = process.env.CLAWDIS_SSH_PORT?.trim();
    const sshPortParsed = sshPortEnv ? Number.parseInt(sshPortEnv, 10) : NaN;
    const sshPort =
      Number.isFinite(sshPortParsed) && sshPortParsed > 0
        ? sshPortParsed
        : undefined;

    const bonjour = await startGatewayBonjourAdvertiser({
      instanceName: formatBonjourInstanceName(machineDisplayName),
      gatewayPort: port,
      bridgePort: bridge?.port,
      canvasPort: canvasHostPortForBridge,
      sshPort,
      tailnetDns,
      cliPath: resolveBonjourCliPath(),
    });
    bonjourStop = bonjour.stop;
  } catch (err) {
    logDiscovery.warn(`bonjour advertising failed: ${String(err)}`);
  }

  if (wideAreaDiscoveryEnabled && bridge?.port) {
    const tailnetIPv4 = pickPrimaryTailnetIPv4();
    if (!tailnetIPv4) {
      logDiscovery.warn(
        "discovery.wideArea.enabled is true, but no Tailscale IPv4 address was found; skipping unicast DNS-SD zone update",
      );
    } else {
      try {
        const tailnetIPv6 = pickPrimaryTailnetIPv6();
        const result = await writeWideAreaBridgeZone({
          bridgePort: bridge.port,
          displayName: formatBonjourInstanceName(machineDisplayName),
          tailnetIPv4,
          tailnetIPv6: tailnetIPv6 ?? undefined,
          tailnetDns,
        });
        logDiscovery.info(
          `wide-area DNS-SD ${result.changed ? "updated" : "unchanged"} (${WIDE_AREA_DISCOVERY_DOMAIN} → ${result.zonePath})`,
        );
      } catch (err) {
        logDiscovery.warn(`wide-area discovery update failed: ${String(err)}`);
      }
    }
  }

  broadcastHealthUpdate = (snap: HealthSummary) => {
    broadcast("health", snap, {
      stateVersion: { presence: presenceVersion, health: healthVersion },
    });
    bridgeSendToAllSubscribed("health", snap);
  };

  // periodic keepalive
  const tickInterval = setInterval(() => {
    const payload = { ts: Date.now() };
    broadcast("tick", payload, { dropIfSlow: true });
    bridgeSendToAllSubscribed("tick", payload);
  }, TICK_INTERVAL_MS);

  // periodic health refresh to keep cached snapshot warm
  const healthInterval = setInterval(() => {
    void refreshHealthSnapshot({ probe: true }).catch((err) =>
      logHealth.error(`refresh failed: ${formatError(err)}`),
    );
  }, HEALTH_REFRESH_INTERVAL_MS);

  // Prime cache so first client gets a snapshot without waiting.
  void refreshHealthSnapshot({ probe: true }).catch((err) =>
    logHealth.error(`initial refresh failed: ${formatError(err)}`),
  );

  // dedupe cache cleanup
  const dedupeCleanup = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of dedupe) {
      if (now - v.ts > DEDUPE_TTL_MS) dedupe.delete(k);
    }
    if (dedupe.size > DEDUPE_MAX) {
      const entries = [...dedupe.entries()].sort((a, b) => a[1].ts - b[1].ts);
      for (let i = 0; i < dedupe.size - DEDUPE_MAX; i++) {
        dedupe.delete(entries[i][0]);
      }
    }
  }, 60_000);

  const agentUnsub = onAgentEvent((evt) => {
    const last = agentRunSeq.get(evt.runId) ?? 0;
    if (evt.seq !== last + 1) {
      // Fan out an error event so clients can refresh the stream on gaps.
      broadcast("agent", {
        runId: evt.runId,
        stream: "error",
        ts: Date.now(),
        data: {
          reason: "seq gap",
          expected: last + 1,
          received: evt.seq,
        },
      });
    }
    agentRunSeq.set(evt.runId, evt.seq);
    broadcast("agent", evt);

    const chatLink = chatRunSessions.get(evt.runId);
    if (chatLink) {
      // Map agent bus events to chat events for WS WebChat clients.
      // Use clientRunId so the webchat can correlate with its pending promise.
      const { sessionKey, clientRunId } = chatLink;
      bridgeSendToSession(sessionKey, "agent", evt);
      const base = {
        runId: clientRunId,
        sessionKey,
        seq: evt.seq,
      };
      if (evt.stream === "assistant" && typeof evt.data?.text === "string") {
        chatRunBuffers.set(clientRunId, evt.data.text);
        const now = Date.now();
        const last = chatDeltaSentAt.get(clientRunId) ?? 0;
        // Throttle UI delta events so slow clients don't accumulate unbounded buffers.
        if (now - last >= 150) {
          chatDeltaSentAt.set(clientRunId, now);
          const payload = {
            ...base,
            state: "delta" as const,
            message: {
              role: "assistant",
              content: [{ type: "text", text: evt.data.text }],
              timestamp: now,
            },
          };
          broadcast("chat", payload, { dropIfSlow: true });
          bridgeSendToSession(sessionKey, "chat", payload);
        }
      } else if (
        evt.stream === "job" &&
        typeof evt.data?.state === "string" &&
        (evt.data.state === "done" || evt.data.state === "error")
      ) {
        const text = chatRunBuffers.get(clientRunId)?.trim() ?? "";
        chatRunBuffers.delete(clientRunId);
        chatDeltaSentAt.delete(clientRunId);
        if (evt.data.state === "done") {
          const payload = {
            ...base,
            state: "final",
            message: text
              ? {
                  role: "assistant",
                  content: [{ type: "text", text }],
                  timestamp: Date.now(),
                }
              : undefined,
          };
          broadcast("chat", payload);
          bridgeSendToSession(sessionKey, "chat", payload);
        } else {
          const payload = {
            ...base,
            state: "error",
            errorMessage: evt.data.error
              ? formatForLog(evt.data.error)
              : undefined,
          };
          broadcast("chat", payload);
          bridgeSendToSession(sessionKey, "chat", payload);
        }
        chatRunSessions.delete(evt.runId);
      }
    }
  });

  const heartbeatUnsub = onHeartbeatEvent((evt) => {
    broadcast("heartbeat", evt, { dropIfSlow: true });
  });

  const heartbeatRunner = startHeartbeatRunner({ cfg: cfgAtStart });

  void cron
    .start()
    .catch((err) => logCron.error(`failed to start: ${String(err)}`));

  wss.on("connection", (socket, upgradeReq) => {
    let client: Client | null = null;
    let closed = false;
    const connId = randomUUID();
    const remoteAddr = (
      socket as WebSocket & { _socket?: { remoteAddress?: string } }
    )._socket?.remoteAddress;
    const canvasHostPortForWs =
      canvasHostServer?.port ?? (canvasHost ? port : undefined);
    const canvasHostOverride =
      bridgeHost && bridgeHost !== "0.0.0.0" && bridgeHost !== "::"
        ? bridgeHost
        : undefined;
    const canvasHostUrl = resolveCanvasHostUrl({
      canvasPort: canvasHostPortForWs,
      hostOverride: canvasHostServer ? canvasHostOverride : undefined,
      requestHost: upgradeReq.headers.host,
      forwardedProto: upgradeReq.headers["x-forwarded-proto"],
      localAddress: upgradeReq.socket?.localAddress,
    });
    logWs("in", "open", { connId, remoteAddr });
    const isWebchatConnect = (params: ConnectParams | null | undefined) =>
      params?.client?.mode === "webchat" ||
      params?.client?.name === "webchat-ui";

    const send = (obj: unknown) => {
      try {
        socket.send(JSON.stringify(obj));
      } catch {
        /* ignore */
      }
    };

    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(handshakeTimer);
      if (client) clients.delete(client);
      try {
        socket.close(1000);
      } catch {
        /* ignore */
      }
    };

    socket.once("error", (err) => {
      logWsControl.warn(
        `error conn=${connId} remote=${remoteAddr ?? "?"}: ${formatError(err)}`,
      );
      close();
    });
    socket.once("close", (code, reason) => {
      if (!client) {
        logWsControl.warn(
          `closed before connect conn=${connId} remote=${remoteAddr ?? "?"} code=${code ?? "n/a"} reason=${reason?.toString() || "n/a"}`,
        );
      }
      if (client && isWebchatConnect(client.connect)) {
        logWsControl.info(
          `webchat disconnected code=${code} reason=${reason?.toString() || "n/a"} conn=${connId}`,
        );
      }
      if (client?.presenceKey) {
        // mark presence as disconnected
        upsertPresence(client.presenceKey, {
          reason: "disconnect",
        });
        presenceVersion += 1;
        broadcast(
          "presence",
          { presence: listSystemPresence() },
          {
            dropIfSlow: true,
            stateVersion: { presence: presenceVersion, health: healthVersion },
          },
        );
      }
      logWs("out", "close", {
        connId,
        code,
        reason: reason?.toString(),
      });
      close();
    });

    const handshakeTimer = setTimeout(() => {
      if (!client) {
        logWsControl.warn(
          `handshake timeout conn=${connId} remote=${remoteAddr ?? "?"}`,
        );
        close();
      }
    }, HANDSHAKE_TIMEOUT_MS);

    socket.on("message", async (data) => {
      if (closed) return;
      const text = rawDataToString(data);
      try {
        const parsed = JSON.parse(text);
        if (!client) {
          // Handshake must be a normal request:
          // { type:"req", method:"connect", params: ConnectParams }.
          if (
            !validateRequestFrame(parsed) ||
            (parsed as RequestFrame).method !== "connect" ||
            !validateConnectParams((parsed as RequestFrame).params)
          ) {
            if (validateRequestFrame(parsed)) {
              const req = parsed as RequestFrame;
              send({
                type: "res",
                id: req.id,
                ok: false,
                error: errorShape(
                  ErrorCodes.INVALID_REQUEST,
                  req.method === "connect"
                    ? `invalid connect params: ${formatValidationErrors(validateConnectParams.errors)}`
                    : "invalid handshake: first request must be connect",
                ),
              });
            } else {
              logWsControl.warn(
                `invalid handshake conn=${connId} remote=${remoteAddr ?? "?"}`,
              );
            }
            socket.close(1008, "invalid handshake");
            close();
            return;
          }

          const frame = parsed as RequestFrame;
          const connectParams = frame.params as ConnectParams;

          // protocol negotiation
          const { minProtocol, maxProtocol } = connectParams;
          if (
            maxProtocol < PROTOCOL_VERSION ||
            minProtocol > PROTOCOL_VERSION
          ) {
            logWsControl.warn(
              `protocol mismatch conn=${connId} remote=${remoteAddr ?? "?"} client=${connectParams.client.name} ${connectParams.client.mode} v${connectParams.client.version}`,
            );
            send({
              type: "res",
              id: frame.id,
              ok: false,
              error: errorShape(
                ErrorCodes.INVALID_REQUEST,
                "protocol mismatch",
                {
                  details: { expectedProtocol: PROTOCOL_VERSION },
                },
              ),
            });
            socket.close(1002, "protocol mismatch");
            close();
            return;
          }

          const authResult = await authorizeGatewayConnect({
            auth: resolvedAuth,
            connectAuth: connectParams.auth,
            req: upgradeReq,
          });
          if (!authResult.ok) {
            logWsControl.warn(
              `unauthorized conn=${connId} remote=${remoteAddr ?? "?"} client=${connectParams.client.name} ${connectParams.client.mode} v${connectParams.client.version}`,
            );
            send({
              type: "res",
              id: frame.id,
              ok: false,
              error: errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized"),
            });
            socket.close(1008, "unauthorized");
            close();
            return;
          }
          const authMethod = authResult.method ?? "none";

          const shouldTrackPresence = connectParams.client.mode !== "cli";
          const presenceKey = shouldTrackPresence
            ? connectParams.client.instanceId || connId
            : undefined;

          logWs("in", "connect", {
            connId,
            client: connectParams.client.name,
            version: connectParams.client.version,
            mode: connectParams.client.mode,
            instanceId: connectParams.client.instanceId,
            platform: connectParams.client.platform,
            auth: authMethod,
          });

          if (isWebchatConnect(connectParams)) {
            logWsControl.info(
              `webchat connected conn=${connId} remote=${remoteAddr ?? "?"} client=${connectParams.client.name} ${connectParams.client.mode} v${connectParams.client.version}`,
            );
          }

          if (presenceKey) {
            upsertPresence(presenceKey, {
              host: connectParams.client.name || os.hostname(),
              ip: isLoopbackAddress(remoteAddr) ? undefined : remoteAddr,
              version: connectParams.client.version,
              platform: connectParams.client.platform,
              deviceFamily: connectParams.client.deviceFamily,
              modelIdentifier: connectParams.client.modelIdentifier,
              mode: connectParams.client.mode,
              instanceId: connectParams.client.instanceId,
              reason: "connect",
            });
            presenceVersion += 1;
          }

          const snapshot = buildSnapshot();
          if (healthCache) {
            snapshot.health = healthCache;
            snapshot.stateVersion.health = healthVersion;
          }
          const helloOk = {
            type: "hello-ok",
            protocol: PROTOCOL_VERSION,
            server: {
              version:
                process.env.CLAWDIS_VERSION ??
                process.env.npm_package_version ??
                "dev",
              commit: process.env.GIT_COMMIT,
              host: os.hostname(),
              connId,
            },
            features: { methods: METHODS, events: EVENTS },
            snapshot,
            canvasHostUrl,
            policy: {
              maxPayload: MAX_PAYLOAD_BYTES,
              maxBufferedBytes: MAX_BUFFERED_BYTES,
              tickIntervalMs: TICK_INTERVAL_MS,
            },
          };

          clearTimeout(handshakeTimer);
          client = { socket, connect: connectParams, connId, presenceKey };

          logWs("out", "hello-ok", {
            connId,
            methods: METHODS.length,
            events: EVENTS.length,
            presence: snapshot.presence.length,
            stateVersion: snapshot.stateVersion.presence,
          });

          send({ type: "res", id: frame.id, ok: true, payload: helloOk });

          clients.add(client);
          void refreshHealthSnapshot({ probe: true }).catch((err) =>
            logHealth.error(
              `post-connect health refresh failed: ${formatError(err)}`,
            ),
          );
          return;
        }

        // After handshake, accept only req frames
        if (!validateRequestFrame(parsed)) {
          send({
            type: "res",
            id: (parsed as { id?: unknown })?.id ?? "invalid",
            ok: false,
            error: errorShape(
              ErrorCodes.INVALID_REQUEST,
              `invalid request frame: ${formatValidationErrors(validateRequestFrame.errors)}`,
            ),
          });
          return;
        }
        const req = parsed as RequestFrame;
        logWs("in", "req", {
          connId,
          id: req.id,
          method: req.method,
        });
        const respond = (
          ok: boolean,
          payload?: unknown,
          error?: ErrorShape,
          meta?: Record<string, unknown>,
        ) => {
          send({ type: "res", id: req.id, ok, payload, error });
          logWs("out", "res", {
            connId,
            id: req.id,
            ok,
            method: req.method,
            errorCode: error?.code,
            errorMessage: error?.message,
            ...meta,
          });
        };

        void (async () => {
          switch (req.method) {
            case "connect": {
              respond(
                false,
                undefined,
                errorShape(
                  ErrorCodes.INVALID_REQUEST,
                  "connect is only valid as the first request",
                ),
              );
              break;
            }
            case "voicewake.get": {
              try {
                const cfg = await loadVoiceWakeConfig();
                respond(true, { triggers: cfg.triggers });
              } catch (err) {
                respond(
                  false,
                  undefined,
                  errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)),
                );
              }
              break;
            }
            case "voicewake.set": {
              const params = (req.params ?? {}) as Record<string, unknown>;
              if (!Array.isArray(params.triggers)) {
                respond(
                  false,
                  undefined,
                  errorShape(
                    ErrorCodes.INVALID_REQUEST,
                    "voicewake.set requires triggers: string[]",
                  ),
                );
                break;
              }
              try {
                const triggers = normalizeVoiceWakeTriggers(params.triggers);
                const cfg = await setVoiceWakeTriggers(triggers);
                broadcastVoiceWakeChanged(cfg.triggers);
                respond(true, { triggers: cfg.triggers });
              } catch (err) {
                respond(
                  false,
                  undefined,
                  errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)),
                );
              }
              break;
            }
            case "health": {
              const now = Date.now();
              const cached = healthCache;
              if (cached && now - cached.ts < HEALTH_REFRESH_INTERVAL_MS) {
                respond(true, cached, undefined, { cached: true });
                void refreshHealthSnapshot({ probe: false }).catch((err) =>
                  logHealth.error(
                    `background health refresh failed: ${formatError(err)}`,
                  ),
                );
                break;
              }
              try {
                const snap = await refreshHealthSnapshot({ probe: false });
                respond(true, snap, undefined);
              } catch (err) {
                respond(
                  false,
                  undefined,
                  errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)),
                );
              }
              break;
            }
            case "providers.status": {
              const params = (req.params ?? {}) as Record<string, unknown>;
              if (!validateProvidersStatusParams(params)) {
                respond(
                  false,
                  undefined,
                  errorShape(
                    ErrorCodes.INVALID_REQUEST,
                    `invalid providers.status params: ${formatValidationErrors(validateProvidersStatusParams.errors)}`,
                  ),
                );
                break;
              }
              const probe = (params as { probe?: boolean }).probe === true;
              const timeoutMsRaw = (params as { timeoutMs?: unknown })
                .timeoutMs;
              const timeoutMs =
                typeof timeoutMsRaw === "number"
                  ? Math.max(1000, timeoutMsRaw)
                  : 10_000;
              const cfg = loadConfig();
              const envToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
              const configToken = cfg.telegram?.botToken?.trim();
              const telegramToken = envToken || configToken || "";
              const tokenSource = envToken
                ? "env"
                : configToken
                  ? "config"
                  : "none";
              let telegramProbe: TelegramProbe | undefined;
              let lastProbeAt: number | null = null;
              if (probe && telegramToken) {
                telegramProbe = await probeTelegram(
                  telegramToken,
                  timeoutMs,
                  cfg.telegram?.proxy,
                );
                lastProbeAt = Date.now();
              }

              const discordEnvToken = process.env.DISCORD_BOT_TOKEN?.trim();
              const discordConfigToken = cfg.discord?.token?.trim();
              const discordToken = discordEnvToken || discordConfigToken || "";
              const discordTokenSource = discordEnvToken
                ? "env"
                : discordConfigToken
                  ? "config"
                  : "none";
              let discordProbe: DiscordProbe | undefined;
              let discordLastProbeAt: number | null = null;
              if (probe && discordToken) {
                discordProbe = await probeDiscord(discordToken, timeoutMs);
                discordLastProbeAt = Date.now();
              }

              const linked = await webAuthExists();
              const authAgeMs = getWebAuthAgeMs();
              const self = readWebSelfId();

              respond(
                true,
                {
                  ts: Date.now(),
                  whatsapp: {
                    configured: linked,
                    linked,
                    authAgeMs,
                    self,
                    running: whatsappRuntime.running,
                    connected: whatsappRuntime.connected,
                    lastConnectedAt: whatsappRuntime.lastConnectedAt ?? null,
                    lastDisconnect: whatsappRuntime.lastDisconnect ?? null,
                    reconnectAttempts: whatsappRuntime.reconnectAttempts,
                    lastMessageAt: whatsappRuntime.lastMessageAt ?? null,
                    lastEventAt: whatsappRuntime.lastEventAt ?? null,
                    lastError: whatsappRuntime.lastError ?? null,
                  },
                  telegram: {
                    configured: Boolean(telegramToken),
                    tokenSource,
                    running: telegramRuntime.running,
                    mode: telegramRuntime.mode ?? null,
                    lastStartAt: telegramRuntime.lastStartAt ?? null,
                    lastStopAt: telegramRuntime.lastStopAt ?? null,
                    lastError: telegramRuntime.lastError ?? null,
                    probe: telegramProbe,
                    lastProbeAt,
                  },
                  discord: {
                    configured: Boolean(discordToken),
                    tokenSource: discordTokenSource,
                    running: discordRuntime.running,
                    lastStartAt: discordRuntime.lastStartAt ?? null,
                    lastStopAt: discordRuntime.lastStopAt ?? null,
                    lastError: discordRuntime.lastError ?? null,
                    probe: discordProbe,
                    lastProbeAt: discordLastProbeAt,
                  },
                },
                undefined,
              );
              break;
            }
            case "chat.history": {
              const params = (req.params ?? {}) as Record<string, unknown>;
              if (!validateChatHistoryParams(params)) {
                respond(
                  false,
                  undefined,
                  errorShape(
                    ErrorCodes.INVALID_REQUEST,
                    `invalid chat.history params: ${formatValidationErrors(validateChatHistoryParams.errors)}`,
                  ),
                );
                break;
              }
              const { sessionKey, limit } = params as {
                sessionKey: string;
                limit?: number;
              };
              const { storePath, entry } = loadSessionEntry(sessionKey);
              const sessionId = entry?.sessionId;
              const rawMessages =
                sessionId && storePath
                  ? readSessionMessages(sessionId, storePath)
                  : [];
              const hardMax = 1000;
              const defaultLimit = 200;
              const requested =
                typeof limit === "number" ? limit : defaultLimit;
              const max = Math.min(hardMax, requested);
              const sliced =
                rawMessages.length > max
                  ? rawMessages.slice(-max)
                  : rawMessages;
              const capped = capArrayByJsonBytes(
                sliced,
                MAX_CHAT_HISTORY_MESSAGES_BYTES,
              ).items;
              const thinkingLevel =
                entry?.thinkingLevel ??
                loadConfig().agent?.thinkingDefault ??
                "off";
              respond(true, {
                sessionKey,
                sessionId,
                messages: capped,
                thinkingLevel,
              });
              break;
            }
            case "chat.abort": {
              const params = (req.params ?? {}) as Record<string, unknown>;
              if (!validateChatAbortParams(params)) {
                respond(
                  false,
                  undefined,
                  errorShape(
                    ErrorCodes.INVALID_REQUEST,
                    `invalid chat.abort params: ${formatValidationErrors(validateChatAbortParams.errors)}`,
                  ),
                );
                break;
              }
              const { sessionKey, runId } = params as {
                sessionKey: string;
                runId: string;
              };
              const active = chatAbortControllers.get(runId);
              if (!active) {
                respond(true, { ok: true, aborted: false });
                break;
              }
              if (active.sessionKey !== sessionKey) {
                respond(
                  false,
                  undefined,
                  errorShape(
                    ErrorCodes.INVALID_REQUEST,
                    "runId does not match sessionKey",
                  ),
                );
                break;
              }

              active.controller.abort();
              chatAbortControllers.delete(runId);
              chatRunBuffers.delete(runId);
              chatDeltaSentAt.delete(runId);
              const current = chatRunSessions.get(active.sessionId);
              if (
                current?.clientRunId === runId &&
                current.sessionKey === sessionKey
              ) {
                chatRunSessions.delete(active.sessionId);
              }

              const payload = {
                runId,
                sessionKey,
                seq: (agentRunSeq.get(active.sessionId) ?? 0) + 1,
                state: "aborted" as const,
              };
              broadcast("chat", payload);
              bridgeSendToSession(sessionKey, "chat", payload);
              respond(true, { ok: true, aborted: true });
              break;
            }
            case "chat.send": {
              const params = (req.params ?? {}) as Record<string, unknown>;
              if (!validateChatSendParams(params)) {
                respond(
                  false,
                  undefined,
                  errorShape(
                    ErrorCodes.INVALID_REQUEST,
                    `invalid chat.send params: ${formatValidationErrors(validateChatSendParams.errors)}`,
                  ),
                );
                break;
              }
              const p = params as {
                sessionKey: string;
                message: string;
                thinking?: string;
                deliver?: boolean;
                attachments?: Array<{
                  type?: string;
                  mimeType?: string;
                  fileName?: string;
                  content?: unknown;
                }>;
                timeoutMs?: number;
                idempotencyKey: string;
              };
              const timeoutMs = Math.min(
                Math.max(p.timeoutMs ?? 30_000, 0),
                30_000,
              );
              const normalizedAttachments =
                p.attachments?.map((a) => ({
                  type: typeof a?.type === "string" ? a.type : undefined,
                  mimeType:
                    typeof a?.mimeType === "string" ? a.mimeType : undefined,
                  fileName:
                    typeof a?.fileName === "string" ? a.fileName : undefined,
                  content:
                    typeof a?.content === "string"
                      ? a.content
                      : ArrayBuffer.isView(a?.content)
                        ? Buffer.from(
                            a.content.buffer,
                            a.content.byteOffset,
                            a.content.byteLength,
                          ).toString("base64")
                        : undefined,
                })) ?? [];
              let messageWithAttachments = p.message;
              if (normalizedAttachments.length > 0) {
                try {
                  messageWithAttachments = buildMessageWithAttachments(
                    p.message,
                    normalizedAttachments,
                    { maxBytes: 5_000_000 },
                  );
                } catch (err) {
                  respond(
                    false,
                    undefined,
                    errorShape(ErrorCodes.INVALID_REQUEST, String(err)),
                  );
                  break;
                }
              }
              const { storePath, store, entry } = loadSessionEntry(
                p.sessionKey,
              );
              const now = Date.now();
              const sessionId = entry?.sessionId ?? randomUUID();
              const sessionEntry: SessionEntry = {
                sessionId,
                updatedAt: now,
                thinkingLevel: entry?.thinkingLevel,
                verboseLevel: entry?.verboseLevel,
                systemSent: entry?.systemSent,
                lastChannel: entry?.lastChannel,
                lastTo: entry?.lastTo,
              };
              const clientRunId = p.idempotencyKey;

              const cached = dedupe.get(`chat:${clientRunId}`);
              if (cached) {
                respond(cached.ok, cached.payload, cached.error, {
                  cached: true,
                });
                break;
              }

              try {
                const abortController = new AbortController();
                chatAbortControllers.set(clientRunId, {
                  controller: abortController,
                  sessionId,
                  sessionKey: p.sessionKey,
                });
                chatRunSessions.set(sessionId, {
                  sessionKey: p.sessionKey,
                  clientRunId,
                });

                if (store) {
                  store[p.sessionKey] = sessionEntry;
                  if (storePath) {
                    await saveSessionStore(storePath, store);
                  }
                }

                await agentCommand(
                  {
                    message: messageWithAttachments,
                    sessionId,
                    thinking: p.thinking,
                    deliver: p.deliver,
                    timeout: Math.ceil(timeoutMs / 1000).toString(),
                    surface: "WebChat",
                    abortSignal: abortController.signal,
                  },
                  defaultRuntime,
                  deps,
                );
                const payload = {
                  runId: clientRunId,
                  status: "ok" as const,
                };
                dedupe.set(`chat:${clientRunId}`, {
                  ts: Date.now(),
                  ok: true,
                  payload,
                });
                respond(true, payload, undefined, { runId: clientRunId });
              } catch (err) {
                const error = errorShape(ErrorCodes.UNAVAILABLE, String(err));
                const payload = {
                  runId: clientRunId,
                  status: "error" as const,
                  summary: String(err),
                };
                dedupe.set(`chat:${clientRunId}`, {
                  ts: Date.now(),
                  ok: false,
                  payload,
                  error,
                });
                respond(false, payload, error, {
                  runId: clientRunId,
                  error: formatForLog(err),
                });
              } finally {
                chatAbortControllers.delete(clientRunId);
              }
              break;
            }
            case "wake": {
              const params = (req.params ?? {}) as Record<string, unknown>;
              if (!validateWakeParams(params)) {
                respond(
                  false,
                  undefined,
                  errorShape(
                    ErrorCodes.INVALID_REQUEST,
                    `invalid wake params: ${formatValidationErrors(validateWakeParams.errors)}`,
                  ),
                );
                break;
              }
              const p = params as {
                mode: "now" | "next-heartbeat";
                text: string;
              };
              const result = cron.wake({ mode: p.mode, text: p.text });
              respond(true, result, undefined);
              break;
            }
            case "cron.list": {
              const params = (req.params ?? {}) as Record<string, unknown>;
              if (!validateCronListParams(params)) {
                respond(
                  false,
                  undefined,
                  errorShape(
                    ErrorCodes.INVALID_REQUEST,
                    `invalid cron.list params: ${formatValidationErrors(validateCronListParams.errors)}`,
                  ),
                );
                break;
              }
              const p = params as { includeDisabled?: boolean };
              const jobs = await cron.list({
                includeDisabled: p.includeDisabled,
              });
              respond(true, { jobs }, undefined);
              break;
            }
            case "cron.status": {
              const params = (req.params ?? {}) as Record<string, unknown>;
              if (!validateCronStatusParams(params)) {
                respond(
                  false,
                  undefined,
                  errorShape(
                    ErrorCodes.INVALID_REQUEST,
                    `invalid cron.status params: ${formatValidationErrors(validateCronStatusParams.errors)}`,
                  ),
                );
                break;
              }
              const status = await cron.status();
              respond(true, status, undefined);
              break;
            }
            case "cron.add": {
              const params = (req.params ?? {}) as Record<string, unknown>;
              if (!validateCronAddParams(params)) {
                respond(
                  false,
                  undefined,
                  errorShape(
                    ErrorCodes.INVALID_REQUEST,
                    `invalid cron.add params: ${formatValidationErrors(validateCronAddParams.errors)}`,
                  ),
                );
                break;
              }
              const job = await cron.add(params as unknown as CronJobCreate);
              respond(true, job, undefined);
              break;
            }
            case "cron.update": {
              const params = (req.params ?? {}) as Record<string, unknown>;
              if (!validateCronUpdateParams(params)) {
                respond(
                  false,
                  undefined,
                  errorShape(
                    ErrorCodes.INVALID_REQUEST,
                    `invalid cron.update params: ${formatValidationErrors(validateCronUpdateParams.errors)}`,
                  ),
                );
                break;
              }
              const p = params as {
                id: string;
                patch: Record<string, unknown>;
              };
              const job = await cron.update(
                p.id,
                p.patch as unknown as CronJobPatch,
              );
              respond(true, job, undefined);
              break;
            }
            case "cron.remove": {
              const params = (req.params ?? {}) as Record<string, unknown>;
              if (!validateCronRemoveParams(params)) {
                respond(
                  false,
                  undefined,
                  errorShape(
                    ErrorCodes.INVALID_REQUEST,
                    `invalid cron.remove params: ${formatValidationErrors(validateCronRemoveParams.errors)}`,
                  ),
                );
                break;
              }
              const p = params as { id: string };
              const result = await cron.remove(p.id);
              respond(true, result, undefined);
              break;
            }
            case "cron.run": {
              const params = (req.params ?? {}) as Record<string, unknown>;
              if (!validateCronRunParams(params)) {
                respond(
                  false,
                  undefined,
                  errorShape(
                    ErrorCodes.INVALID_REQUEST,
                    `invalid cron.run params: ${formatValidationErrors(validateCronRunParams.errors)}`,
                  ),
                );
                break;
              }
              const p = params as { id: string; mode?: "due" | "force" };
              const result = await cron.run(p.id, p.mode);
              respond(true, result, undefined);
              break;
            }
            case "cron.runs": {
              const params = (req.params ?? {}) as Record<string, unknown>;
              if (!validateCronRunsParams(params)) {
                respond(
                  false,
                  undefined,
                  errorShape(
                    ErrorCodes.INVALID_REQUEST,
                    `invalid cron.runs params: ${formatValidationErrors(validateCronRunsParams.errors)}`,
                  ),
                );
                break;
              }
              const p = params as { id: string; limit?: number };
              const logPath = resolveCronRunLogPath({
                storePath: cronStorePath,
                jobId: p.id,
              });
              const entries = await readCronRunLogEntries(logPath, {
                limit: p.limit,
                jobId: p.id,
              });
              respond(true, { entries }, undefined);
              break;
            }
            case "status": {
              const status = await getStatusSummary();
              respond(true, status, undefined);
              break;
            }
            case "web.login.start": {
              const params = (req.params ?? {}) as Record<string, unknown>;
              if (!validateWebLoginStartParams(params)) {
                respond(
                  false,
                  undefined,
                  errorShape(
                    ErrorCodes.INVALID_REQUEST,
                    `invalid web.login.start params: ${formatValidationErrors(validateWebLoginStartParams.errors)}`,
                  ),
                );
                break;
              }
              try {
                await stopWhatsAppProvider();
                const result = await startWebLoginWithQr({
                  force: Boolean((params as { force?: boolean }).force),
                  timeoutMs:
                    typeof (params as { timeoutMs?: unknown }).timeoutMs ===
                    "number"
                      ? (params as { timeoutMs?: number }).timeoutMs
                      : undefined,
                  verbose: Boolean((params as { verbose?: boolean }).verbose),
                });
                respond(true, result, undefined);
              } catch (err) {
                respond(
                  false,
                  undefined,
                  errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)),
                );
              }
              break;
            }
            case "web.login.wait": {
              const params = (req.params ?? {}) as Record<string, unknown>;
              if (!validateWebLoginWaitParams(params)) {
                respond(
                  false,
                  undefined,
                  errorShape(
                    ErrorCodes.INVALID_REQUEST,
                    `invalid web.login.wait params: ${formatValidationErrors(validateWebLoginWaitParams.errors)}`,
                  ),
                );
                break;
              }
              try {
                const result = await waitForWebLogin({
                  timeoutMs:
                    typeof (params as { timeoutMs?: unknown }).timeoutMs ===
                    "number"
                      ? (params as { timeoutMs?: number }).timeoutMs
                      : undefined,
                });
                if (result.connected) {
                  await startWhatsAppProvider();
                }
                respond(true, result, undefined);
              } catch (err) {
                respond(
                  false,
                  undefined,
                  errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)),
                );
              }
              break;
            }
            case "web.logout": {
              try {
                await stopWhatsAppProvider();
                const cleared = await logoutWeb(defaultRuntime);
                whatsappRuntime = {
                  ...whatsappRuntime,
                  running: false,
                  connected: false,
                  lastError: cleared ? "logged out" : whatsappRuntime.lastError,
                };
                respond(true, { cleared }, undefined);
              } catch (err) {
                respond(
                  false,
                  undefined,
                  errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)),
                );
              }
              break;
            }
            case "telegram.logout": {
              try {
                await stopTelegramProvider();
                const snapshot = await readConfigFileSnapshot();
                if (!snapshot.valid) {
                  respond(
                    false,
                    undefined,
                    errorShape(
                      ErrorCodes.INVALID_REQUEST,
                      "config invalid; fix it before logging out",
                    ),
                  );
                  break;
                }
                const cfg = snapshot.config ?? {};
                const envToken = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
                const hadToken = Boolean(cfg.telegram?.botToken);
                const nextTelegram = cfg.telegram
                  ? { ...cfg.telegram }
                  : undefined;
                if (nextTelegram) {
                  delete nextTelegram.botToken;
                }
                const nextCfg = { ...cfg } as ClawdisConfig;
                if (nextTelegram && Object.keys(nextTelegram).length > 0) {
                  nextCfg.telegram = nextTelegram;
                } else {
                  delete nextCfg.telegram;
                }
                await writeConfigFile(nextCfg);
                respond(
                  true,
                  { cleared: hadToken, envToken: Boolean(envToken) },
                  undefined,
                );
              } catch (err) {
                respond(
                  false,
                  undefined,
                  errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)),
                );
              }
              break;
            }
            case "models.list": {
              const params = (req.params ?? {}) as Record<string, unknown>;
              if (!validateModelsListParams(params)) {
                respond(
                  false,
                  undefined,
                  errorShape(
                    ErrorCodes.INVALID_REQUEST,
                    `invalid models.list params: ${formatValidationErrors(validateModelsListParams.errors)}`,
                  ),
                );
                break;
              }
              try {
                const models = await loadGatewayModelCatalog();
                respond(true, { models }, undefined);
              } catch (err) {
                respond(
                  false,
                  undefined,
                  errorShape(ErrorCodes.UNAVAILABLE, String(err)),
                );
              }
              break;
            }
            case "config.get": {
              const params = (req.params ?? {}) as Record<string, unknown>;
              if (!validateConfigGetParams(params)) {
                respond(
                  false,
                  undefined,
                  errorShape(
                    ErrorCodes.INVALID_REQUEST,
                    `invalid config.get params: ${formatValidationErrors(validateConfigGetParams.errors)}`,
                  ),
                );
                break;
              }
              const snapshot = await readConfigFileSnapshot();
              respond(true, snapshot, undefined);
              break;
            }
            case "config.set": {
              const params = (req.params ?? {}) as Record<string, unknown>;
              if (!validateConfigSetParams(params)) {
                respond(
                  false,
                  undefined,
                  errorShape(
                    ErrorCodes.INVALID_REQUEST,
                    `invalid config.set params: ${formatValidationErrors(validateConfigSetParams.errors)}`,
                  ),
                );
                break;
              }
              const rawValue = (params as { raw?: unknown }).raw;
              if (typeof rawValue !== "string") {
                respond(
                  false,
                  undefined,
                  errorShape(
                    ErrorCodes.INVALID_REQUEST,
                    "invalid config.set params: raw (string) required",
                  ),
                );
                break;
              }
              const parsedRes = parseConfigJson5(rawValue);
              if (!parsedRes.ok) {
                respond(
                  false,
                  undefined,
                  errorShape(ErrorCodes.INVALID_REQUEST, parsedRes.error),
                );
                break;
              }
              const validated = validateConfigObject(parsedRes.parsed);
              if (!validated.ok) {
                respond(
                  false,
                  undefined,
                  errorShape(ErrorCodes.INVALID_REQUEST, "invalid config", {
                    details: { issues: validated.issues },
                  }),
                );
                break;
              }
              await writeConfigFile(validated.config);
              respond(
                true,
                {
                  ok: true,
                  path: CONFIG_PATH_CLAWDIS,
                  config: validated.config,
                },
                undefined,
              );
              break;
            }
            case "skills.status": {
              const params = (req.params ?? {}) as Record<string, unknown>;
              if (!validateSkillsStatusParams(params)) {
                respond(
                  false,
                  undefined,
                  errorShape(
                    ErrorCodes.INVALID_REQUEST,
                    `invalid skills.status params: ${formatValidationErrors(validateSkillsStatusParams.errors)}`,
                  ),
                );
                break;
              }
              const cfg = loadConfig();
              const workspaceDirRaw =
                cfg.agent?.workspace ?? DEFAULT_AGENT_WORKSPACE_DIR;
              const workspaceDir = resolveUserPath(workspaceDirRaw);
              const report = buildWorkspaceSkillStatus(workspaceDir, {
                config: cfg,
              });
              respond(true, report, undefined);
              break;
            }
            case "skills.install": {
              const params = (req.params ?? {}) as Record<string, unknown>;
              if (!validateSkillsInstallParams(params)) {
                respond(
                  false,
                  undefined,
                  errorShape(
                    ErrorCodes.INVALID_REQUEST,
                    `invalid skills.install params: ${formatValidationErrors(validateSkillsInstallParams.errors)}`,
                  ),
                );
                break;
              }
              const p = params as {
                name: string;
                installId: string;
                timeoutMs?: number;
              };
              const cfg = loadConfig();
              const workspaceDirRaw =
                cfg.agent?.workspace ?? DEFAULT_AGENT_WORKSPACE_DIR;
              const result = await installSkill({
                workspaceDir: workspaceDirRaw,
                skillName: p.name,
                installId: p.installId,
                timeoutMs: p.timeoutMs,
                config: cfg,
              });
              respond(
                result.ok,
                result,
                result.ok
                  ? undefined
                  : errorShape(ErrorCodes.UNAVAILABLE, result.message),
              );
              break;
            }
            case "skills.update": {
              const params = (req.params ?? {}) as Record<string, unknown>;
              if (!validateSkillsUpdateParams(params)) {
                respond(
                  false,
                  undefined,
                  errorShape(
                    ErrorCodes.INVALID_REQUEST,
                    `invalid skills.update params: ${formatValidationErrors(validateSkillsUpdateParams.errors)}`,
                  ),
                );
                break;
              }
              const p = params as {
                skillKey: string;
                enabled?: boolean;
                apiKey?: string;
                env?: Record<string, string>;
              };
              const cfg = loadConfig();
              const skills = cfg.skills ? { ...cfg.skills } : {};
              const current = skills[p.skillKey]
                ? { ...skills[p.skillKey] }
                : {};
              if (typeof p.enabled === "boolean") {
                current.enabled = p.enabled;
              }
              if (typeof p.apiKey === "string") {
                const trimmed = p.apiKey.trim();
                if (trimmed) current.apiKey = trimmed;
                else delete current.apiKey;
              }
              if (p.env && typeof p.env === "object") {
                const nextEnv = current.env ? { ...current.env } : {};
                for (const [key, value] of Object.entries(p.env)) {
                  const trimmedKey = key.trim();
                  if (!trimmedKey) continue;
                  const trimmedVal = value.trim();
                  if (!trimmedVal) delete nextEnv[trimmedKey];
                  else nextEnv[trimmedKey] = trimmedVal;
                }
                current.env = nextEnv;
              }
              skills[p.skillKey] = current;
              const nextConfig: ClawdisConfig = {
                ...cfg,
                skills,
              };
              await writeConfigFile(nextConfig);
              respond(
                true,
                { ok: true, skillKey: p.skillKey, config: current },
                undefined,
              );
              break;
            }
            case "sessions.list": {
              const params = (req.params ?? {}) as Record<string, unknown>;
              if (!validateSessionsListParams(params)) {
                respond(
                  false,
                  undefined,
                  errorShape(
                    ErrorCodes.INVALID_REQUEST,
                    `invalid sessions.list params: ${formatValidationErrors(validateSessionsListParams.errors)}`,
                  ),
                );
                break;
              }
              const p = params as SessionsListParams;
              const cfg = loadConfig();
              const storePath = resolveStorePath(cfg.session?.store);
              const store = loadSessionStore(storePath);
              const result = listSessionsFromStore({
                cfg,
                storePath,
                store,
                opts: p,
              });
              respond(true, result, undefined);
              break;
            }
            case "sessions.patch": {
              const params = (req.params ?? {}) as Record<string, unknown>;
              if (!validateSessionsPatchParams(params)) {
                respond(
                  false,
                  undefined,
                  errorShape(
                    ErrorCodes.INVALID_REQUEST,
                    `invalid sessions.patch params: ${formatValidationErrors(validateSessionsPatchParams.errors)}`,
                  ),
                );
                break;
              }
              const p = params as SessionsPatchParams;
              const key = String(p.key ?? "").trim();
              if (!key) {
                respond(
                  false,
                  undefined,
                  errorShape(ErrorCodes.INVALID_REQUEST, "key required"),
                );
                break;
              }

              const cfg = loadConfig();
              const storePath = resolveStorePath(cfg.session?.store);
              const store = loadSessionStore(storePath);
              const now = Date.now();

              const existing = store[key];
              const next: SessionEntry = existing
                ? {
                    ...existing,
                    updatedAt: Math.max(existing.updatedAt ?? 0, now),
                  }
                : { sessionId: randomUUID(), updatedAt: now };

              if ("thinkingLevel" in p) {
                const raw = p.thinkingLevel;
                if (raw === null) {
                  delete next.thinkingLevel;
                } else if (raw !== undefined) {
                  const normalized = normalizeThinkLevel(String(raw));
                  if (!normalized) {
                    respond(
                      false,
                      undefined,
                      errorShape(
                        ErrorCodes.INVALID_REQUEST,
                        "invalid thinkingLevel (use off|minimal|low|medium|high)",
                      ),
                    );
                    break;
                  }
                  if (normalized === "off") delete next.thinkingLevel;
                  else next.thinkingLevel = normalized;
                }
              }

              if ("verboseLevel" in p) {
                const raw = p.verboseLevel;
                if (raw === null) {
                  delete next.verboseLevel;
                } else if (raw !== undefined) {
                  const normalized = normalizeVerboseLevel(String(raw));
                  if (!normalized) {
                    respond(
                      false,
                      undefined,
                      errorShape(
                        ErrorCodes.INVALID_REQUEST,
                        'invalid verboseLevel (use "on"|"off")',
                      ),
                    );
                    break;
                  }
                  if (normalized === "off") delete next.verboseLevel;
                  else next.verboseLevel = normalized;
                }
              }

              if ("groupActivation" in p) {
                const raw = p.groupActivation;
                if (raw === null) {
                  delete next.groupActivation;
                } else if (raw !== undefined) {
                  const normalized = normalizeGroupActivation(String(raw));
                  if (!normalized) {
                    respond(
                      false,
                      undefined,
                      errorShape(
                        ErrorCodes.INVALID_REQUEST,
                        'invalid groupActivation (use "mention"|"always")',
                      ),
                    );
                    break;
                  }
                  next.groupActivation = normalized;
                }
              }

              store[key] = next;
              await saveSessionStore(storePath, store);
              const result: SessionsPatchResult = {
                ok: true,
                path: storePath,
                key,
                entry: next,
              };
              respond(true, result, undefined);
              break;
            }
            case "sessions.reset": {
              const params = (req.params ?? {}) as Record<string, unknown>;
              if (!validateSessionsResetParams(params)) {
                respond(
                  false,
                  undefined,
                  errorShape(
                    ErrorCodes.INVALID_REQUEST,
                    `invalid sessions.reset params: ${formatValidationErrors(validateSessionsResetParams.errors)}`,
                  ),
                );
                break;
              }
              const p = params as SessionsResetParams;
              const key = String(p.key ?? "").trim();
              if (!key) {
                respond(
                  false,
                  undefined,
                  errorShape(ErrorCodes.INVALID_REQUEST, "key required"),
                );
                break;
              }

              const { storePath, store, entry } = loadSessionEntry(key);
              const now = Date.now();
              const next: SessionEntry = {
                sessionId: randomUUID(),
                updatedAt: now,
                systemSent: false,
                abortedLastRun: false,
                thinkingLevel: entry?.thinkingLevel,
                verboseLevel: entry?.verboseLevel,
                model: entry?.model,
                contextTokens: entry?.contextTokens,
                lastChannel: entry?.lastChannel,
                lastTo: entry?.lastTo,
                skillsSnapshot: entry?.skillsSnapshot,
              };
              store[key] = next;
              await saveSessionStore(storePath, store);
              respond(true, { ok: true, key, entry: next }, undefined);
              break;
            }
            case "sessions.delete": {
              const params = (req.params ?? {}) as Record<string, unknown>;
              if (!validateSessionsDeleteParams(params)) {
                respond(
                  false,
                  undefined,
                  errorShape(
                    ErrorCodes.INVALID_REQUEST,
                    `invalid sessions.delete params: ${formatValidationErrors(validateSessionsDeleteParams.errors)}`,
                  ),
                );
                break;
              }
              const p = params as SessionsDeleteParams;
              const key = String(p.key ?? "").trim();
              if (!key) {
                respond(
                  false,
                  undefined,
                  errorShape(ErrorCodes.INVALID_REQUEST, "key required"),
                );
                break;
              }

              const deleteTranscript =
                typeof p.deleteTranscript === "boolean"
                  ? p.deleteTranscript
                  : true;

              const { storePath, store, entry } = loadSessionEntry(key);
              const sessionId = entry?.sessionId;
              const existed = Boolean(store[key]);
              if (existed) delete store[key];
              await saveSessionStore(storePath, store);

              const archived: string[] = [];
              if (deleteTranscript && sessionId) {
                for (const candidate of resolveSessionTranscriptCandidates(
                  sessionId,
                  storePath,
                )) {
                  if (!fs.existsSync(candidate)) continue;
                  try {
                    archived.push(archiveFileOnDisk(candidate, "deleted"));
                  } catch {
                    // Best-effort.
                  }
                }
              }

              respond(
                true,
                { ok: true, key, deleted: existed, archived },
                undefined,
              );
              break;
            }
            case "sessions.compact": {
              const params = (req.params ?? {}) as Record<string, unknown>;
              if (!validateSessionsCompactParams(params)) {
                respond(
                  false,
                  undefined,
                  errorShape(
                    ErrorCodes.INVALID_REQUEST,
                    `invalid sessions.compact params: ${formatValidationErrors(validateSessionsCompactParams.errors)}`,
                  ),
                );
                break;
              }
              const p = params as SessionsCompactParams;
              const key = String(p.key ?? "").trim();
              if (!key) {
                respond(
                  false,
                  undefined,
                  errorShape(ErrorCodes.INVALID_REQUEST, "key required"),
                );
                break;
              }

              const maxLines =
                typeof p.maxLines === "number" && Number.isFinite(p.maxLines)
                  ? Math.max(1, Math.floor(p.maxLines))
                  : 400;

              const { storePath, store, entry } = loadSessionEntry(key);
              const sessionId = entry?.sessionId;
              if (!sessionId) {
                respond(
                  true,
                  { ok: true, key, compacted: false, reason: "no sessionId" },
                  undefined,
                );
                break;
              }

              const filePath = resolveSessionTranscriptCandidates(
                sessionId,
                storePath,
              ).find((candidate) => fs.existsSync(candidate));
              if (!filePath) {
                respond(
                  true,
                  { ok: true, key, compacted: false, reason: "no transcript" },
                  undefined,
                );
                break;
              }

              const raw = fs.readFileSync(filePath, "utf-8");
              const lines = raw
                .split(/\r?\n/)
                .filter((l) => l.trim().length > 0);
              if (lines.length <= maxLines) {
                respond(
                  true,
                  { ok: true, key, compacted: false, kept: lines.length },
                  undefined,
                );
                break;
              }

              const archived = archiveFileOnDisk(filePath, "bak");
              const keptLines = lines.slice(-maxLines);
              fs.writeFileSync(filePath, `${keptLines.join("\n")}\n`, "utf-8");

              if (store[key]) {
                delete store[key].inputTokens;
                delete store[key].outputTokens;
                delete store[key].totalTokens;
                store[key].updatedAt = Date.now();
                await saveSessionStore(storePath, store);
              }

              respond(
                true,
                {
                  ok: true,
                  key,
                  compacted: true,
                  archived,
                  kept: keptLines.length,
                },
                undefined,
              );
              break;
            }
            case "last-heartbeat": {
              respond(true, getLastHeartbeatEvent(), undefined);
              break;
            }
            case "set-heartbeats": {
              const params = (req.params ?? {}) as Record<string, unknown>;
              const enabled = params.enabled;
              if (typeof enabled !== "boolean") {
                respond(
                  false,
                  undefined,
                  errorShape(
                    ErrorCodes.INVALID_REQUEST,
                    "invalid set-heartbeats params: enabled (boolean) required",
                  ),
                );
                break;
              }
              setHeartbeatsEnabled(enabled);
              respond(true, { ok: true, enabled }, undefined);
              break;
            }
            case "system-presence": {
              const presence = listSystemPresence();
              respond(true, presence, undefined);
              break;
            }
            case "system-event": {
              const params = (req.params ?? {}) as Record<string, unknown>;
              const text =
                typeof params.text === "string" ? params.text.trim() : "";
              if (!text) {
                respond(
                  false,
                  undefined,
                  errorShape(ErrorCodes.INVALID_REQUEST, "text required"),
                );
                break;
              }
              const instanceId =
                typeof params.instanceId === "string"
                  ? params.instanceId
                  : undefined;
              const host =
                typeof params.host === "string" ? params.host : undefined;
              const ip = typeof params.ip === "string" ? params.ip : undefined;
              const mode =
                typeof params.mode === "string" ? params.mode : undefined;
              const version =
                typeof params.version === "string" ? params.version : undefined;
              const platform =
                typeof params.platform === "string"
                  ? params.platform
                  : undefined;
              const deviceFamily =
                typeof params.deviceFamily === "string"
                  ? params.deviceFamily
                  : undefined;
              const modelIdentifier =
                typeof params.modelIdentifier === "string"
                  ? params.modelIdentifier
                  : undefined;
              const lastInputSeconds =
                typeof params.lastInputSeconds === "number" &&
                Number.isFinite(params.lastInputSeconds)
                  ? params.lastInputSeconds
                  : undefined;
              const reason =
                typeof params.reason === "string" ? params.reason : undefined;
              const tags =
                Array.isArray(params.tags) &&
                params.tags.every((t) => typeof t === "string")
                  ? (params.tags as string[])
                  : undefined;
              const presenceUpdate = updateSystemPresence({
                text,
                instanceId,
                host,
                ip,
                mode,
                version,
                platform,
                deviceFamily,
                modelIdentifier,
                lastInputSeconds,
                reason,
                tags,
              });
              const isNodePresenceLine = text.startsWith("Node:");
              if (isNodePresenceLine) {
                const next = presenceUpdate.next;
                const changed = new Set(presenceUpdate.changedKeys);
                const reasonValue = next.reason ?? reason;
                const normalizedReason = (reasonValue ?? "").toLowerCase();
                const ignoreReason =
                  normalizedReason.startsWith("periodic") ||
                  normalizedReason === "heartbeat";
                const hostChanged = changed.has("host");
                const ipChanged = changed.has("ip");
                const versionChanged = changed.has("version");
                const modeChanged = changed.has("mode");
                const reasonChanged = changed.has("reason") && !ignoreReason;
                const hasChanges =
                  hostChanged ||
                  ipChanged ||
                  versionChanged ||
                  modeChanged ||
                  reasonChanged;
                if (hasChanges) {
                  const contextChanged = isSystemEventContextChanged(
                    presenceUpdate.key,
                  );
                  const parts: string[] = [];
                  if (contextChanged || hostChanged || ipChanged) {
                    const hostLabel = next.host?.trim() || "Unknown";
                    const ipLabel = next.ip?.trim();
                    parts.push(
                      `Node: ${hostLabel}${ipLabel ? ` (${ipLabel})` : ""}`,
                    );
                  }
                  if (versionChanged) {
                    parts.push(`app ${next.version?.trim() || "unknown"}`);
                  }
                  if (modeChanged) {
                    parts.push(`mode ${next.mode?.trim() || "unknown"}`);
                  }
                  if (reasonChanged) {
                    parts.push(`reason ${reasonValue?.trim() || "event"}`);
                  }
                  const deltaText = parts.join(" · ");
                  if (deltaText) {
                    enqueueSystemEvent(deltaText, {
                      contextKey: presenceUpdate.key,
                    });
                  }
                }
              } else {
                enqueueSystemEvent(text);
              }
              presenceVersion += 1;
              broadcast(
                "presence",
                { presence: listSystemPresence() },
                {
                  dropIfSlow: true,
                  stateVersion: {
                    presence: presenceVersion,
                    health: healthVersion,
                  },
                },
              );
              respond(true, { ok: true }, undefined);
              break;
            }
            case "node.pair.request": {
              const params = (req.params ?? {}) as Record<string, unknown>;
              if (!validateNodePairRequestParams(params)) {
                respond(
                  false,
                  undefined,
                  errorShape(
                    ErrorCodes.INVALID_REQUEST,
                    `invalid node.pair.request params: ${formatValidationErrors(validateNodePairRequestParams.errors)}`,
                  ),
                );
                break;
              }
              const p = params as {
                nodeId: string;
                displayName?: string;
                platform?: string;
                version?: string;
                deviceFamily?: string;
                modelIdentifier?: string;
                caps?: string[];
                commands?: string[];
                remoteIp?: string;
                silent?: boolean;
              };
              try {
                const result = await requestNodePairing({
                  nodeId: p.nodeId,
                  displayName: p.displayName,
                  platform: p.platform,
                  version: p.version,
                  deviceFamily: p.deviceFamily,
                  modelIdentifier: p.modelIdentifier,
                  caps: p.caps,
                  commands: p.commands,
                  remoteIp: p.remoteIp,
                  silent: p.silent,
                });
                if (result.status === "pending" && result.created) {
                  broadcast("node.pair.requested", result.request, {
                    dropIfSlow: true,
                  });
                }
                respond(true, result, undefined);
              } catch (err) {
                respond(
                  false,
                  undefined,
                  errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)),
                );
              }
              break;
            }
            case "node.pair.list": {
              const params = (req.params ?? {}) as Record<string, unknown>;
              if (!validateNodePairListParams(params)) {
                respond(
                  false,
                  undefined,
                  errorShape(
                    ErrorCodes.INVALID_REQUEST,
                    `invalid node.pair.list params: ${formatValidationErrors(validateNodePairListParams.errors)}`,
                  ),
                );
                break;
              }
              try {
                const list = await listNodePairing();
                respond(true, list, undefined);
              } catch (err) {
                respond(
                  false,
                  undefined,
                  errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)),
                );
              }
              break;
            }
            case "node.pair.approve": {
              const params = (req.params ?? {}) as Record<string, unknown>;
              if (!validateNodePairApproveParams(params)) {
                respond(
                  false,
                  undefined,
                  errorShape(
                    ErrorCodes.INVALID_REQUEST,
                    `invalid node.pair.approve params: ${formatValidationErrors(validateNodePairApproveParams.errors)}`,
                  ),
                );
                break;
              }
              const { requestId } = params as { requestId: string };
              try {
                const approved = await approveNodePairing(requestId);
                if (!approved) {
                  respond(
                    false,
                    undefined,
                    errorShape(ErrorCodes.INVALID_REQUEST, "unknown requestId"),
                  );
                  break;
                }
                broadcast(
                  "node.pair.resolved",
                  {
                    requestId,
                    nodeId: approved.node.nodeId,
                    decision: "approved",
                    ts: Date.now(),
                  },
                  { dropIfSlow: true },
                );
                respond(true, approved, undefined);
              } catch (err) {
                respond(
                  false,
                  undefined,
                  errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)),
                );
              }
              break;
            }
            case "node.pair.reject": {
              const params = (req.params ?? {}) as Record<string, unknown>;
              if (!validateNodePairRejectParams(params)) {
                respond(
                  false,
                  undefined,
                  errorShape(
                    ErrorCodes.INVALID_REQUEST,
                    `invalid node.pair.reject params: ${formatValidationErrors(validateNodePairRejectParams.errors)}`,
                  ),
                );
                break;
              }
              const { requestId } = params as { requestId: string };
              try {
                const rejected = await rejectNodePairing(requestId);
                if (!rejected) {
                  respond(
                    false,
                    undefined,
                    errorShape(ErrorCodes.INVALID_REQUEST, "unknown requestId"),
                  );
                  break;
                }
                broadcast(
                  "node.pair.resolved",
                  {
                    requestId,
                    nodeId: rejected.nodeId,
                    decision: "rejected",
                    ts: Date.now(),
                  },
                  { dropIfSlow: true },
                );
                respond(true, rejected, undefined);
              } catch (err) {
                respond(
                  false,
                  undefined,
                  errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)),
                );
              }
              break;
            }
            case "node.pair.verify": {
              const params = (req.params ?? {}) as Record<string, unknown>;
              if (!validateNodePairVerifyParams(params)) {
                respond(
                  false,
                  undefined,
                  errorShape(
                    ErrorCodes.INVALID_REQUEST,
                    `invalid node.pair.verify params: ${formatValidationErrors(validateNodePairVerifyParams.errors)}`,
                  ),
                );
                break;
              }
              const { nodeId, token } = params as {
                nodeId: string;
                token: string;
              };
              try {
                const result = await verifyNodeToken(nodeId, token);
                respond(true, result, undefined);
              } catch (err) {
                respond(
                  false,
                  undefined,
                  errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)),
                );
              }
              break;
            }
            case "node.rename": {
              const params = (req.params ?? {}) as Record<string, unknown>;
              if (!validateNodeRenameParams(params)) {
                respond(
                  false,
                  undefined,
                  errorShape(
                    ErrorCodes.INVALID_REQUEST,
                    `invalid node.rename params: ${formatValidationErrors(validateNodeRenameParams.errors)}`,
                  ),
                );
                break;
              }
              const { nodeId, displayName } = params as {
                nodeId: string;
                displayName: string;
              };
              try {
                const trimmed = displayName.trim();
                if (!trimmed) {
                  respond(
                    false,
                    undefined,
                    errorShape(
                      ErrorCodes.INVALID_REQUEST,
                      "displayName required",
                    ),
                  );
                  break;
                }
                const updated = await renamePairedNode(nodeId, trimmed);
                if (!updated) {
                  respond(
                    false,
                    undefined,
                    errorShape(ErrorCodes.INVALID_REQUEST, "unknown nodeId"),
                  );
                  break;
                }
                respond(
                  true,
                  { nodeId: updated.nodeId, displayName: updated.displayName },
                  undefined,
                );
              } catch (err) {
                respond(
                  false,
                  undefined,
                  errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)),
                );
              }
              break;
            }
            case "node.list": {
              const params = (req.params ?? {}) as Record<string, unknown>;
              if (!validateNodeListParams(params)) {
                respond(
                  false,
                  undefined,
                  errorShape(
                    ErrorCodes.INVALID_REQUEST,
                    `invalid node.list params: ${formatValidationErrors(validateNodeListParams.errors)}`,
                  ),
                );
                break;
              }

              try {
                const list = await listNodePairing();
                const pairedById = new Map(
                  list.paired.map((n) => [n.nodeId, n]),
                );

                const connected = bridge?.listConnected?.() ?? [];
                const connectedById = new Map(
                  connected.map((n) => [n.nodeId, n]),
                );

                const nodeIds = new Set<string>([
                  ...pairedById.keys(),
                  ...connectedById.keys(),
                ]);

                const nodes = [...nodeIds].map((nodeId) => {
                  const paired = pairedById.get(nodeId);
                  const live = connectedById.get(nodeId);

                  const caps = [
                    ...new Set(
                      (live?.caps ?? paired?.caps ?? [])
                        .map((c) => String(c).trim())
                        .filter(Boolean),
                    ),
                  ].sort();

                  const commands = [
                    ...new Set(
                      (live?.commands ?? paired?.commands ?? [])
                        .map((c) => String(c).trim())
                        .filter(Boolean),
                    ),
                  ].sort();

                  return {
                    nodeId,
                    displayName: live?.displayName ?? paired?.displayName,
                    platform: live?.platform ?? paired?.platform,
                    version: live?.version ?? paired?.version,
                    deviceFamily: live?.deviceFamily ?? paired?.deviceFamily,
                    modelIdentifier:
                      live?.modelIdentifier ?? paired?.modelIdentifier,
                    remoteIp: live?.remoteIp ?? paired?.remoteIp,
                    caps,
                    commands,
                    permissions: live?.permissions ?? paired?.permissions,
                    paired: Boolean(paired),
                    connected: Boolean(live),
                  };
                });

                nodes.sort((a, b) => {
                  if (a.connected !== b.connected) return a.connected ? -1 : 1;
                  const an = (a.displayName ?? a.nodeId).toLowerCase();
                  const bn = (b.displayName ?? b.nodeId).toLowerCase();
                  if (an < bn) return -1;
                  if (an > bn) return 1;
                  return a.nodeId.localeCompare(b.nodeId);
                });

                respond(true, { ts: Date.now(), nodes }, undefined);
              } catch (err) {
                respond(
                  false,
                  undefined,
                  errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)),
                );
              }
              break;
            }
            case "node.describe": {
              const params = (req.params ?? {}) as Record<string, unknown>;
              if (!validateNodeDescribeParams(params)) {
                respond(
                  false,
                  undefined,
                  errorShape(
                    ErrorCodes.INVALID_REQUEST,
                    `invalid node.describe params: ${formatValidationErrors(validateNodeDescribeParams.errors)}`,
                  ),
                );
                break;
              }
              const { nodeId } = params as { nodeId: string };
              const id = String(nodeId ?? "").trim();
              if (!id) {
                respond(
                  false,
                  undefined,
                  errorShape(ErrorCodes.INVALID_REQUEST, "nodeId required"),
                );
                break;
              }

              try {
                const list = await listNodePairing();
                const paired = list.paired.find((n) => n.nodeId === id);
                const connected = bridge?.listConnected?.() ?? [];
                const live = connected.find((n) => n.nodeId === id);

                if (!paired && !live) {
                  respond(
                    false,
                    undefined,
                    errorShape(ErrorCodes.INVALID_REQUEST, "unknown nodeId"),
                  );
                  break;
                }

                const caps = [
                  ...new Set(
                    (live?.caps ?? paired?.caps ?? [])
                      .map((c) => String(c).trim())
                      .filter(Boolean),
                  ),
                ].sort();

                const commands = [
                  ...new Set(
                    (live?.commands ?? paired?.commands ?? [])
                      .map((c) => String(c).trim())
                      .filter(Boolean),
                  ),
                ].sort();

                respond(
                  true,
                  {
                    ts: Date.now(),
                    nodeId: id,
                    displayName: live?.displayName ?? paired?.displayName,
                    platform: live?.platform ?? paired?.platform,
                    version: live?.version ?? paired?.version,
                    deviceFamily: live?.deviceFamily ?? paired?.deviceFamily,
                    modelIdentifier:
                      live?.modelIdentifier ?? paired?.modelIdentifier,
                    remoteIp: live?.remoteIp ?? paired?.remoteIp,
                    caps,
                    commands,
                    permissions: live?.permissions ?? paired?.permissions,
                    paired: Boolean(paired),
                    connected: Boolean(live),
                  },
                  undefined,
                );
              } catch (err) {
                respond(
                  false,
                  undefined,
                  errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)),
                );
              }
              break;
            }
            case "node.invoke": {
              const params = (req.params ?? {}) as Record<string, unknown>;
              if (!validateNodeInvokeParams(params)) {
                respond(
                  false,
                  undefined,
                  errorShape(
                    ErrorCodes.INVALID_REQUEST,
                    `invalid node.invoke params: ${formatValidationErrors(validateNodeInvokeParams.errors)}`,
                  ),
                );
                break;
              }
              if (!bridge) {
                respond(
                  false,
                  undefined,
                  errorShape(ErrorCodes.UNAVAILABLE, "bridge not running"),
                );
                break;
              }
              const p = params as {
                nodeId: string;
                command: string;
                params?: unknown;
                timeoutMs?: number;
                idempotencyKey: string;
              };
              const nodeId = String(p.nodeId ?? "").trim();
              const command = String(p.command ?? "").trim();
              if (!nodeId || !command) {
                respond(
                  false,
                  undefined,
                  errorShape(
                    ErrorCodes.INVALID_REQUEST,
                    "nodeId and command required",
                  ),
                );
                break;
              }

              try {
                const paramsJSON =
                  "params" in p && p.params !== undefined
                    ? JSON.stringify(p.params)
                    : null;
                const res = await bridge.invoke({
                  nodeId,
                  command,
                  paramsJSON,
                  timeoutMs: p.timeoutMs,
                });
                if (!res.ok) {
                  respond(
                    false,
                    undefined,
                    errorShape(
                      ErrorCodes.UNAVAILABLE,
                      res.error?.message ?? "node invoke failed",
                      { details: { nodeError: res.error ?? null } },
                    ),
                  );
                  break;
                }
                const payload =
                  typeof res.payloadJSON === "string" && res.payloadJSON.trim()
                    ? (() => {
                        try {
                          return JSON.parse(res.payloadJSON) as unknown;
                        } catch {
                          return { payloadJSON: res.payloadJSON };
                        }
                      })()
                    : undefined;
                respond(
                  true,
                  {
                    ok: true,
                    nodeId,
                    command,
                    payload,
                    payloadJSON: res.payloadJSON ?? null,
                  },
                  undefined,
                );
              } catch (err) {
                respond(
                  false,
                  undefined,
                  errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)),
                );
              }
              break;
            }
            case "send": {
              const p = (req.params ?? {}) as Record<string, unknown>;
              if (!validateSendParams(p)) {
                respond(
                  false,
                  undefined,
                  errorShape(
                    ErrorCodes.INVALID_REQUEST,
                    `invalid send params: ${formatValidationErrors(validateSendParams.errors)}`,
                  ),
                );
                break;
              }
              const params = p as {
                to: string;
                message: string;
                mediaUrl?: string;
                provider?: string;
                idempotencyKey: string;
              };
              const idem = params.idempotencyKey;
              const cached = dedupe.get(`send:${idem}`);
              if (cached) {
                respond(cached.ok, cached.payload, cached.error, {
                  cached: true,
                });
                break;
              }
              const to = params.to.trim();
              const message = params.message.trim();
              const provider = (params.provider ?? "whatsapp").toLowerCase();
              try {
                if (provider === "telegram") {
                  const result = await sendMessageTelegram(to, message, {
                    mediaUrl: params.mediaUrl,
                    verbose: isVerbose(),
                  });
                  const payload = {
                    runId: idem,
                    messageId: result.messageId,
                    chatId: result.chatId,
                    provider,
                  };
                  dedupe.set(`send:${idem}`, {
                    ts: Date.now(),
                    ok: true,
                    payload,
                  });
                  respond(true, payload, undefined, { provider });
                } else if (provider === "discord") {
                  const result = await sendMessageDiscord(to, message, {
                    mediaUrl: params.mediaUrl,
                    token: process.env.DISCORD_BOT_TOKEN,
                  });
                  const payload = {
                    runId: idem,
                    messageId: result.messageId,
                    channelId: result.channelId,
                    provider,
                  };
                  dedupe.set(`send:${idem}`, {
                    ts: Date.now(),
                    ok: true,
                    payload,
                  });
                  respond(true, payload, undefined, { provider });
                } else {
                  const result = await sendMessageWhatsApp(to, message, {
                    mediaUrl: params.mediaUrl,
                    verbose: isVerbose(),
                  });
                  const payload = {
                    runId: idem,
                    messageId: result.messageId,
                    toJid: result.toJid ?? `${to}@s.whatsapp.net`,
                    provider,
                  };
                  dedupe.set(`send:${idem}`, {
                    ts: Date.now(),
                    ok: true,
                    payload,
                  });
                  respond(true, payload, undefined, { provider });
                }
              } catch (err) {
                const error = errorShape(ErrorCodes.UNAVAILABLE, String(err));
                dedupe.set(`send:${idem}`, {
                  ts: Date.now(),
                  ok: false,
                  error,
                });
                respond(false, undefined, error, {
                  provider,
                  error: formatForLog(err),
                });
              }
              break;
            }
            case "agent": {
              const p = (req.params ?? {}) as Record<string, unknown>;
              if (!validateAgentParams(p)) {
                respond(
                  false,
                  undefined,
                  errorShape(
                    ErrorCodes.INVALID_REQUEST,
                    `invalid agent params: ${formatValidationErrors(validateAgentParams.errors)}`,
                  ),
                );
                break;
              }
              const params = p as {
                message: string;
                to?: string;
                sessionId?: string;
                sessionKey?: string;
                thinking?: string;
                deliver?: boolean;
                channel?: string;
                idempotencyKey: string;
                timeout?: number;
              };
              const idem = params.idempotencyKey;
              const cached = dedupe.get(`agent:${idem}`);
              if (cached) {
                respond(cached.ok, cached.payload, cached.error, {
                  cached: true,
                });
                break;
              }
              const message = params.message.trim();

              const requestedSessionKey =
                typeof params.sessionKey === "string" &&
                params.sessionKey.trim()
                  ? params.sessionKey.trim()
                  : undefined;
              let resolvedSessionId = params.sessionId?.trim() || undefined;
              let sessionEntry: SessionEntry | undefined;
              let bestEffortDeliver = false;
              let cfgForAgent: ReturnType<typeof loadConfig> | undefined;

              if (requestedSessionKey) {
                const { cfg, storePath, store, entry } =
                  loadSessionEntry(requestedSessionKey);
                cfgForAgent = cfg;
                const now = Date.now();
                const sessionId = entry?.sessionId ?? randomUUID();
                sessionEntry = {
                  sessionId,
                  updatedAt: now,
                  thinkingLevel: entry?.thinkingLevel,
                  verboseLevel: entry?.verboseLevel,
                  systemSent: entry?.systemSent,
                  skillsSnapshot: entry?.skillsSnapshot,
                  lastChannel: entry?.lastChannel,
                  lastTo: entry?.lastTo,
                };
                if (store) {
                  store[requestedSessionKey] = sessionEntry;
                  if (storePath) {
                    await saveSessionStore(storePath, store);
                  }
                }
                resolvedSessionId = sessionId;
                const mainKey =
                  (cfg.session?.mainKey ?? "main").trim() || "main";
                if (requestedSessionKey === mainKey) {
                  chatRunSessions.set(sessionId, {
                    sessionKey: requestedSessionKey,
                    clientRunId: idem,
                  });
                  bestEffortDeliver = true;
                }
              }

              const runId = resolvedSessionId || randomUUID();

              const requestedChannelRaw =
                typeof params.channel === "string" ? params.channel.trim() : "";
              const requestedChannel = requestedChannelRaw
                ? requestedChannelRaw.toLowerCase()
                : "last";

              const lastChannel = sessionEntry?.lastChannel;
              const lastTo =
                typeof sessionEntry?.lastTo === "string"
                  ? sessionEntry.lastTo.trim()
                  : "";

              const resolvedChannel = (() => {
                if (requestedChannel === "last") {
                  // WebChat is not a deliverable surface. Treat it as "unset" for routing,
                  // so VoiceWake and CLI callers don't get stuck with deliver=false.
                  return lastChannel && lastChannel !== "webchat"
                    ? lastChannel
                    : "whatsapp";
                }
                if (
                  requestedChannel === "whatsapp" ||
                  requestedChannel === "telegram" ||
                  requestedChannel === "discord" ||
                  requestedChannel === "webchat"
                ) {
                  return requestedChannel;
                }
                return lastChannel && lastChannel !== "webchat"
                  ? lastChannel
                  : "whatsapp";
              })();

              const resolvedTo = (() => {
                const explicit =
                  typeof params.to === "string" && params.to.trim()
                    ? params.to.trim()
                    : undefined;
                if (explicit) return explicit;
                if (
                  resolvedChannel === "whatsapp" ||
                  resolvedChannel === "telegram" ||
                  resolvedChannel === "discord"
                ) {
                  return lastTo || undefined;
                }
                return undefined;
              })();

              const sanitizedTo = (() => {
                // If we derived a WhatsApp recipient from session "lastTo", ensure it is still valid
                // for the configured allowlist. Otherwise, fall back to the first allowed number so
                // voice wake doesn't silently route to stale/test recipients.
                if (resolvedChannel !== "whatsapp") return resolvedTo;
                const explicit =
                  typeof params.to === "string" && params.to.trim()
                    ? params.to.trim()
                    : undefined;
                if (explicit) return resolvedTo;

                const cfg = cfgForAgent ?? loadConfig();
                const rawAllow = cfg.routing?.allowFrom ?? [];
                if (rawAllow.includes("*")) return resolvedTo;
                const allowFrom = rawAllow
                  .map((val) => normalizeE164(val))
                  .filter((val) => val.length > 1);
                if (allowFrom.length === 0) return resolvedTo;

                const normalizedLast =
                  typeof resolvedTo === "string" && resolvedTo.trim()
                    ? normalizeE164(resolvedTo)
                    : undefined;
                if (normalizedLast && allowFrom.includes(normalizedLast)) {
                  return normalizedLast;
                }
                return allowFrom[0];
              })();

              const deliver =
                params.deliver === true && resolvedChannel !== "webchat";

              const accepted = { runId, status: "accepted" as const };
              // Store an in-flight ack so retries do not spawn a second run.
              dedupe.set(`agent:${idem}`, {
                ts: Date.now(),
                ok: true,
                payload: accepted,
              });
              respond(true, accepted, undefined, { runId });

              void agentCommand(
                {
                  message,
                  to: sanitizedTo,
                  sessionId: resolvedSessionId,
                  thinking: params.thinking,
                  deliver,
                  provider: resolvedChannel,
                  timeout: params.timeout?.toString(),
                  bestEffortDeliver,
                  surface: "VoiceWake",
                },
                defaultRuntime,
                deps,
              )
                .then(() => {
                  const payload = {
                    runId,
                    status: "ok" as const,
                    summary: "completed",
                  };
                  dedupe.set(`agent:${idem}`, {
                    ts: Date.now(),
                    ok: true,
                    payload,
                  });
                  // Send a second res frame (same id) so TS clients with expectFinal can wait.
                  // Swift clients will typically treat the first res as the result and ignore this.
                  respond(true, payload, undefined, { runId });
                })
                .catch((err) => {
                  const error = errorShape(ErrorCodes.UNAVAILABLE, String(err));
                  const payload = {
                    runId,
                    status: "error" as const,
                    summary: String(err),
                  };
                  dedupe.set(`agent:${idem}`, {
                    ts: Date.now(),
                    ok: false,
                    payload,
                    error,
                  });
                  respond(false, payload, error, {
                    runId,
                    error: formatForLog(err),
                  });
                });
              break;
            }
            default: {
              respond(
                false,
                undefined,
                errorShape(
                  ErrorCodes.INVALID_REQUEST,
                  `unknown method: ${req.method}`,
                ),
              );
              break;
            }
          }
        })().catch((err) => {
          log.error(`request handler failed: ${formatForLog(err)}`);
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)),
          );
        });
      } catch (err) {
        log.error(`parse/handle error: ${String(err)}`);
        logWs("out", "parse-error", { connId, error: formatForLog(err) });
        // If still in handshake, close; otherwise respond error
        if (!client) {
          close();
        }
      }
    });
  });

  const { provider: agentProvider, model: agentModel } =
    resolveConfiguredModelRef({
      cfg: cfgAtStart,
      defaultProvider: DEFAULT_PROVIDER,
      defaultModel: DEFAULT_MODEL,
    });
  const modelRef = `${agentProvider}/${agentModel}`;
  log.info(`agent model: ${modelRef}`, {
    consoleMessage: `agent model: ${chalk.whiteBright(modelRef)}`,
  });
  log.info(`listening on ws://${bindHost}:${port} (PID ${process.pid})`);
  log.info(`log file: ${getResolvedLoggerSettings().file}`);
  if (isNixMode) {
    log.info("gateway: running in Nix mode (config managed externally)");
  }
  let tailscaleCleanup: (() => Promise<void>) | null = null;
  if (tailscaleMode !== "off") {
    try {
      if (tailscaleMode === "serve") {
        await enableTailscaleServe(port);
      } else {
        await enableTailscaleFunnel(port);
      }
      const host = await getTailnetHostname().catch(() => null);
      if (host) {
        logTailscale.info(
          `${tailscaleMode} enabled: https://${host}/ui/ (WS via wss://${host})`,
        );
      } else {
        logTailscale.info(`${tailscaleMode} enabled`);
      }
    } catch (err) {
      logTailscale.warn(
        `${tailscaleMode} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (tailscaleConfig.resetOnExit) {
      tailscaleCleanup = async () => {
        try {
          if (tailscaleMode === "serve") {
            await disableTailscaleServe();
          } else {
            await disableTailscaleFunnel();
          }
        } catch (err) {
          logTailscale.warn(
            `${tailscaleMode} cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      };
    }
  }

  // Start clawd browser control server (unless disabled via config).
  try {
    await startBrowserControlServerIfEnabled();
  } catch (err) {
    logBrowser.error(`server failed to start: ${String(err)}`);
  }

  // Launch configured providers (WhatsApp Web, Discord, Telegram) so gateway replies via the
  // surface the message came from. Tests can opt out via CLAWDIS_SKIP_PROVIDERS.
  if (process.env.CLAWDIS_SKIP_PROVIDERS !== "1") {
    try {
      await startProviders();
    } catch (err) {
      logProviders.error(`provider startup failed: ${String(err)}`);
    }
  } else {
    logProviders.info("skipping provider start (CLAWDIS_SKIP_PROVIDERS=1)");
  }

  return {
    close: async (opts) => {
      const reasonRaw =
        typeof opts?.reason === "string" ? opts.reason.trim() : "";
      const reason = reasonRaw || "gateway stopping";
      const restartExpectedMs =
        typeof opts?.restartExpectedMs === "number" &&
        Number.isFinite(opts.restartExpectedMs)
          ? Math.max(0, Math.floor(opts.restartExpectedMs))
          : null;
      if (bonjourStop) {
        try {
          await bonjourStop();
        } catch {
          /* ignore */
        }
      }
      if (tailscaleCleanup) {
        await tailscaleCleanup();
      }
      if (canvasHost) {
        try {
          await canvasHost.close();
        } catch {
          /* ignore */
        }
      }
      if (canvasHostServer) {
        try {
          await canvasHostServer.close();
        } catch {
          /* ignore */
        }
      }
      if (bridge) {
        try {
          await bridge.close();
        } catch {
          /* ignore */
        }
      }
      await stopWhatsAppProvider();
      await stopTelegramProvider();
      await stopDiscordProvider();
      cron.stop();
      heartbeatRunner.stop();
      broadcast("shutdown", {
        reason,
        restartExpectedMs,
      });
      clearInterval(tickInterval);
      clearInterval(healthInterval);
      clearInterval(dedupeCleanup);
      if (agentUnsub) {
        try {
          agentUnsub();
        } catch {
          /* ignore */
        }
      }
      if (heartbeatUnsub) {
        try {
          heartbeatUnsub();
        } catch {
          /* ignore */
        }
      }
      chatRunSessions.clear();
      chatRunBuffers.clear();
      for (const c of clients) {
        try {
          c.socket.close(1012, "service restart");
        } catch {
          /* ignore */
        }
      }
      clients.clear();
      if (stopBrowserControlServerIfStarted) {
        await stopBrowserControlServerIfStarted().catch(() => {});
      }
      await Promise.allSettled(
        [whatsappTask, telegramTask].filter(Boolean) as Array<Promise<unknown>>,
      );
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve, reject) =>
        httpServer.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}
