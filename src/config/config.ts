import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import JSON5 from "json5";
import { z } from "zod";

import { parseDurationMs } from "../cli/parse-duration.js";

/**
 * Nix mode detection: When CLAWDIS_NIX_MODE=1, the gateway is running under Nix.
 * In this mode:
 * - No auto-install flows should be attempted
 * - Missing dependencies should produce actionable Nix-specific error messages
 * - Config is managed externally (read-only from Nix perspective)
 */
export const isNixMode = process.env.CLAWDIS_NIX_MODE === "1";

export type ReplyMode = "text" | "command";
export type SessionScope = "per-sender" | "global";

export type SessionConfig = {
  scope?: SessionScope;
  resetTriggers?: string[];
  idleMinutes?: number;
  heartbeatIdleMinutes?: number;
  store?: string;
  typingIntervalSeconds?: number;
  mainKey?: string;
};

export type LoggingConfig = {
  level?: "silent" | "fatal" | "error" | "warn" | "info" | "debug" | "trace";
  file?: string;
  consoleLevel?:
    | "silent"
    | "fatal"
    | "error"
    | "warn"
    | "info"
    | "debug"
    | "trace";
  consoleStyle?: "pretty" | "compact" | "json";
};

export type WebReconnectConfig = {
  initialMs?: number;
  maxMs?: number;
  factor?: number;
  jitter?: number;
  maxAttempts?: number; // 0 = unlimited
};

export type WebConfig = {
  /** If false, do not start the WhatsApp web provider. Default: true. */
  enabled?: boolean;
  heartbeatSeconds?: number;
  reconnect?: WebReconnectConfig;
};

export type BrowserConfig = {
  enabled?: boolean;
  /** Base URL of the clawd browser control server. Default: http://127.0.0.1:18791 */
  controlUrl?: string;
  /** Accent color for the clawd browser profile (hex). Default: #FF4500 */
  color?: string;
  /** Start Chrome headless (best-effort). Default: false */
  headless?: boolean;
  /** If true: never launch; only attach to an existing browser. Default: false */
  attachOnly?: boolean;
};

export type CronConfig = {
  enabled?: boolean;
  store?: string;
  maxConcurrentRuns?: number;
};

export type HookMappingMatch = {
  path?: string;
  source?: string;
};

export type HookMappingTransform = {
  module: string;
  export?: string;
};

export type HookMappingConfig = {
  id?: string;
  match?: HookMappingMatch;
  action?: "wake" | "agent";
  wakeMode?: "now" | "next-heartbeat";
  name?: string;
  sessionKey?: string;
  messageTemplate?: string;
  textTemplate?: string;
  deliver?: boolean;
  channel?: "last" | "whatsapp" | "telegram" | "discord";
  to?: string;
  thinking?: string;
  timeoutSeconds?: number;
  transform?: HookMappingTransform;
};

export type HooksGmailTailscaleMode = "off" | "serve" | "funnel";

export type HooksGmailConfig = {
  account?: string;
  label?: string;
  topic?: string;
  subscription?: string;
  pushToken?: string;
  hookUrl?: string;
  includeBody?: boolean;
  maxBytes?: number;
  renewEveryMinutes?: number;
  serve?: {
    bind?: string;
    port?: number;
    path?: string;
  };
  tailscale?: {
    mode?: HooksGmailTailscaleMode;
    path?: string;
  };
};

export type HooksConfig = {
  enabled?: boolean;
  path?: string;
  token?: string;
  maxBodyBytes?: number;
  presets?: string[];
  transformsDir?: string;
  mappings?: HookMappingConfig[];
  gmail?: HooksGmailConfig;
};

export type TelegramConfig = {
  /** If false, do not start the Telegram provider. Default: true. */
  enabled?: boolean;
  botToken?: string;
  /** Path to file containing bot token (for secret managers like agenix) */
  tokenFile?: string;
  requireMention?: boolean;
  allowFrom?: Array<string | number>;
  mediaMaxMb?: number;
  proxy?: string;
  webhookUrl?: string;
  webhookSecret?: string;
  webhookPath?: string;
};

export type DiscordConfig = {
  /** If false, do not start the Discord provider. Default: true. */
  enabled?: boolean;
  token?: string;
  allowFrom?: Array<string | number>;
  guildAllowFrom?: {
    guilds?: Array<string | number>;
    users?: Array<string | number>;
  };
  requireMention?: boolean;
  mediaMaxMb?: number;
};

export type QueueMode = "queue" | "interrupt";

export type QueueModeBySurface = {
  whatsapp?: QueueMode;
  telegram?: QueueMode;
  discord?: QueueMode;
  webchat?: QueueMode;
};

export type GroupChatConfig = {
  requireMention?: boolean;
  mentionPatterns?: string[];
  historyLimit?: number;
};

export type RoutingConfig = {
  allowFrom?: string[]; // E.164 numbers allowed to trigger auto-reply (without whatsapp:)
  transcribeAudio?: {
    // Optional CLI to turn inbound audio into text; templated args, must output transcript to stdout.
    command: string[];
    timeoutSeconds?: number;
  };
  groupChat?: GroupChatConfig;
  queue?: {
    mode?: QueueMode;
    bySurface?: QueueModeBySurface;
  };
};

export type MessagesConfig = {
  messagePrefix?: string; // Prefix added to all inbound messages (default: "[clawdis]" if no allowFrom, else "")
  responsePrefix?: string; // Prefix auto-added to all outbound replies (e.g., "🦞")
  timestampPrefix?: boolean | string; // true/false or IANA timezone string (default: true with UTC)
};

export type BridgeBindMode = "auto" | "lan" | "tailnet" | "loopback";

export type BridgeConfig = {
  enabled?: boolean;
  port?: number;
  /**
   * Bind address policy for the node bridge server.
   * - auto: prefer tailnet IP when present, else LAN (0.0.0.0)
   * - lan:  0.0.0.0 (reachable on local network + any forwarded interfaces)
   * - tailnet: bind to the Tailscale interface IP (100.64.0.0/10) plus loopback
   * - loopback: 127.0.0.1
   */
  bind?: BridgeBindMode;
};

export type WideAreaDiscoveryConfig = {
  enabled?: boolean;
};

export type DiscoveryConfig = {
  wideArea?: WideAreaDiscoveryConfig;
};

export type CanvasHostConfig = {
  enabled?: boolean;
  /** Directory to serve (default: ~/clawd/canvas). */
  root?: string;
  /** HTTP port to listen on (default: 18793). */
  port?: number;
};

export type GatewayControlUiConfig = {
  /** If false, the Gateway will not serve the Control UI (/). Default: true. */
  enabled?: boolean;
};

export type GatewayAuthMode = "token" | "password";

export type GatewayAuthConfig = {
  /** Authentication mode for Gateway connections. Defaults to token when set. */
  mode?: GatewayAuthMode;
  /** Shared password for password mode (consider env instead). */
  password?: string;
  /** Allow Tailscale identity headers when serve mode is enabled. */
  allowTailscale?: boolean;
};

export type GatewayTailscaleMode = "off" | "serve" | "funnel";

export type GatewayTailscaleConfig = {
  /** Tailscale exposure mode for the Gateway control UI. */
  mode?: GatewayTailscaleMode;
  /** Reset serve/funnel configuration on shutdown. */
  resetOnExit?: boolean;
};

export type GatewayConfig = {
  /**
   * Explicit gateway mode. When set to "remote", local gateway start is disabled.
   * When set to "local", the CLI may start the gateway locally.
   */
  mode?: "local" | "remote";
  /**
   * Bind address policy for the Gateway WebSocket + Control UI HTTP server.
   * Default: loopback (127.0.0.1).
   */
  bind?: BridgeBindMode;
  controlUi?: GatewayControlUiConfig;
  auth?: GatewayAuthConfig;
  tailscale?: GatewayTailscaleConfig;
};

export type SkillConfig = {
  enabled?: boolean;
  apiKey?: string;
  env?: Record<string, string>;
  [key: string]: unknown;
};

export type SkillsLoadConfig = {
  /**
   * Additional skill folders to scan (lowest precedence).
   * Each directory should contain skill subfolders with `SKILL.md`.
   */
  extraDirs?: string[];
};

export type SkillsInstallConfig = {
  preferBrew?: boolean;
  nodeManager?: "npm" | "pnpm" | "yarn";
};

export type ModelApi =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai";

export type ModelCompatConfig = {
  supportsStore?: boolean;
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
  maxTokensField?: "max_completion_tokens" | "max_tokens";
};

export type ModelDefinitionConfig = {
  id: string;
  name: string;
  api?: ModelApi;
  reasoning: boolean;
  input: Array<"text" | "image">;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
  headers?: Record<string, string>;
  compat?: ModelCompatConfig;
};

export type ModelProviderConfig = {
  baseUrl: string;
  apiKey: string;
  api?: ModelApi;
  headers?: Record<string, string>;
  authHeader?: boolean;
  models: ModelDefinitionConfig[];
};

export type ModelsConfig = {
  mode?: "merge" | "replace";
  providers?: Record<string, ModelProviderConfig>;
};

export type ClawdisConfig = {
  identity?: {
    name?: string;
    theme?: string;
    emoji?: string;
  };
  logging?: LoggingConfig;
  browser?: BrowserConfig;
  skillsLoad?: SkillsLoadConfig;
  skillsInstall?: SkillsInstallConfig;
  models?: ModelsConfig;
  agent?: {
    /** Model id (provider/model), e.g. "anthropic/claude-opus-4-5". */
    model?: string;
    /** Agent working directory (preferred). Used as the default cwd for agent runs. */
    workspace?: string;
    /** Optional allowlist for /model (provider/model or model-only). */
    allowedModels?: string[];
    /** Optional model aliases for /model (alias -> provider/model). */
    modelAliases?: Record<string, string>;
    /** Optional display-only context window override (used for % in status UIs). */
    contextTokens?: number;
    /** Default thinking level when no /think directive is present. */
    thinkingDefault?: "off" | "minimal" | "low" | "medium" | "high";
    /** Default verbose level when no /verbose directive is present. */
    verboseDefault?: "off" | "on";
    timeoutSeconds?: number;
    /** Max inbound media size in MB for agent-visible attachments (text note or future image attach). */
    mediaMaxMb?: number;
    typingIntervalSeconds?: number;
    /** Periodic background heartbeat runs. */
    heartbeat?: {
      /** Heartbeat interval (duration string, default unit: minutes). */
      every?: string;
      /** Heartbeat model override (provider/model). */
      model?: string;
      /** Delivery target (last|whatsapp|telegram|discord|none). */
      target?: "last" | "whatsapp" | "telegram" | "discord" | "none";
      /** Optional delivery override (E.164 for WhatsApp, chat id for Telegram). */
      to?: string;
      /** Override the heartbeat prompt body (default: "HEARTBEAT"). */
      prompt?: string;
    };
    /** Max concurrent agent runs across all conversations. Default: 1 (sequential). */
    maxConcurrent?: number;
    /** Bash tool defaults. */
    bash?: {
      /** Default time (ms) before a bash command auto-backgrounds. */
      backgroundMs?: number;
      /** Default timeout (seconds) before auto-killing bash commands. */
      timeoutSec?: number;
      /** How long to keep finished sessions in memory (ms). */
      cleanupMs?: number;
    };
  };
  routing?: RoutingConfig;
  messages?: MessagesConfig;
  session?: SessionConfig;
  web?: WebConfig;
  telegram?: TelegramConfig;
  discord?: DiscordConfig;
  cron?: CronConfig;
  hooks?: HooksConfig;
  bridge?: BridgeConfig;
  discovery?: DiscoveryConfig;
  canvasHost?: CanvasHostConfig;
  gateway?: GatewayConfig;
  skills?: Record<string, SkillConfig>;
};

/**
 * State directory for mutable data (sessions, logs, caches).
 * Can be overridden via CLAWDIS_STATE_DIR environment variable.
 * Default: ~/.clawdis
 */
export const STATE_DIR_CLAWDIS =
  process.env.CLAWDIS_STATE_DIR ?? path.join(os.homedir(), ".clawdis");

/**
 * Config file path (JSON5).
 * Can be overridden via CLAWDIS_CONFIG_PATH environment variable.
 * Default: ~/.clawdis/clawdis.json (or $CLAWDIS_STATE_DIR/clawdis.json)
 */
export const CONFIG_PATH_CLAWDIS =
  process.env.CLAWDIS_CONFIG_PATH ??
  path.join(STATE_DIR_CLAWDIS, "clawdis.json");

const ModelApiSchema = z.union([
  z.literal("openai-completions"),
  z.literal("openai-responses"),
  z.literal("anthropic-messages"),
  z.literal("google-generative-ai"),
]);

const ModelCompatSchema = z
  .object({
    supportsStore: z.boolean().optional(),
    supportsDeveloperRole: z.boolean().optional(),
    supportsReasoningEffort: z.boolean().optional(),
    maxTokensField: z
      .union([z.literal("max_completion_tokens"), z.literal("max_tokens")])
      .optional(),
  })
  .optional();

const ModelDefinitionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  api: ModelApiSchema.optional(),
  reasoning: z.boolean(),
  input: z.array(z.union([z.literal("text"), z.literal("image")])),
  cost: z.object({
    input: z.number(),
    output: z.number(),
    cacheRead: z.number(),
    cacheWrite: z.number(),
  }),
  contextWindow: z.number().positive(),
  maxTokens: z.number().positive(),
  headers: z.record(z.string(), z.string()).optional(),
  compat: ModelCompatSchema,
});

const ModelProviderSchema = z.object({
  baseUrl: z.string().min(1),
  apiKey: z.string().min(1),
  api: ModelApiSchema.optional(),
  headers: z.record(z.string(), z.string()).optional(),
  authHeader: z.boolean().optional(),
  models: z.array(ModelDefinitionSchema),
});

const ModelsConfigSchema = z
  .object({
    mode: z.union([z.literal("merge"), z.literal("replace")]).optional(),
    providers: z.record(z.string(), ModelProviderSchema).optional(),
  })
  .optional();

const GroupChatSchema = z
  .object({
    requireMention: z.boolean().optional(),
    mentionPatterns: z.array(z.string()).optional(),
    historyLimit: z.number().int().positive().optional(),
  })
  .optional();

const QueueModeSchema = z.union([z.literal("queue"), z.literal("interrupt")]);

const QueueModeBySurfaceSchema = z
  .object({
    whatsapp: QueueModeSchema.optional(),
    telegram: QueueModeSchema.optional(),
    discord: QueueModeSchema.optional(),
    webchat: QueueModeSchema.optional(),
  })
  .optional();

const TranscribeAudioSchema = z
  .object({
    command: z.array(z.string()),
    timeoutSeconds: z.number().int().positive().optional(),
  })
  .optional();

const SessionSchema = z
  .object({
    scope: z.union([z.literal("per-sender"), z.literal("global")]).optional(),
    resetTriggers: z.array(z.string()).optional(),
    idleMinutes: z.number().int().positive().optional(),
    heartbeatIdleMinutes: z.number().int().positive().optional(),
    store: z.string().optional(),
    typingIntervalSeconds: z.number().int().positive().optional(),
    mainKey: z.string().optional(),
  })
  .optional();

const MessagesSchema = z
  .object({
    messagePrefix: z.string().optional(),
    responsePrefix: z.string().optional(),
    timestampPrefix: z.union([z.boolean(), z.string()]).optional(),
  })
  .optional();

const HeartbeatSchema = z
  .object({
    every: z.string().optional(),
    model: z.string().optional(),
    target: z
      .union([
        z.literal("last"),
        z.literal("whatsapp"),
        z.literal("telegram"),
        z.literal("discord"),
        z.literal("none"),
      ])
      .optional(),
    to: z.string().optional(),
    prompt: z.string().optional(),
  })
  .superRefine((val, ctx) => {
    if (!val.every) return;
    try {
      parseDurationMs(val.every, { defaultUnit: "m" });
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["every"],
        message: "invalid duration (use ms, s, m, h)",
      });
    }
  })
  .optional();

const RoutingSchema = z
  .object({
    allowFrom: z.array(z.string()).optional(),
    groupChat: GroupChatSchema,
    transcribeAudio: TranscribeAudioSchema,
    queue: z
      .object({
        mode: QueueModeSchema.optional(),
        bySurface: QueueModeBySurfaceSchema,
      })
      .optional(),
  })
  .optional();

const HookMappingSchema = z
  .object({
    id: z.string().optional(),
    match: z
      .object({
        path: z.string().optional(),
        source: z.string().optional(),
      })
      .optional(),
    action: z.union([z.literal("wake"), z.literal("agent")]).optional(),
    wakeMode: z
      .union([z.literal("now"), z.literal("next-heartbeat")])
      .optional(),
    name: z.string().optional(),
    sessionKey: z.string().optional(),
    messageTemplate: z.string().optional(),
    textTemplate: z.string().optional(),
    deliver: z.boolean().optional(),
    channel: z
      .union([
        z.literal("last"),
        z.literal("whatsapp"),
        z.literal("telegram"),
        z.literal("discord"),
      ])
      .optional(),
    to: z.string().optional(),
    thinking: z.string().optional(),
    timeoutSeconds: z.number().int().positive().optional(),
    transform: z
      .object({
        module: z.string(),
        export: z.string().optional(),
      })
      .optional(),
  })
  .optional();

const HooksGmailSchema = z
  .object({
    account: z.string().optional(),
    label: z.string().optional(),
    topic: z.string().optional(),
    subscription: z.string().optional(),
    pushToken: z.string().optional(),
    hookUrl: z.string().optional(),
    includeBody: z.boolean().optional(),
    maxBytes: z.number().int().positive().optional(),
    renewEveryMinutes: z.number().int().positive().optional(),
    serve: z
      .object({
        bind: z.string().optional(),
        port: z.number().int().positive().optional(),
        path: z.string().optional(),
      })
      .optional(),
    tailscale: z
      .object({
        mode: z
          .union([z.literal("off"), z.literal("serve"), z.literal("funnel")])
          .optional(),
        path: z.string().optional(),
      })
      .optional(),
  })
  .optional();

const ClawdisSchema = z.object({
  identity: z
    .object({
      name: z.string().optional(),
      theme: z.string().optional(),
      emoji: z.string().optional(),
    })
    .optional(),
  logging: z
    .object({
      level: z
        .union([
          z.literal("silent"),
          z.literal("fatal"),
          z.literal("error"),
          z.literal("warn"),
          z.literal("info"),
          z.literal("debug"),
          z.literal("trace"),
        ])
        .optional(),
      file: z.string().optional(),
      consoleLevel: z
        .union([
          z.literal("silent"),
          z.literal("fatal"),
          z.literal("error"),
          z.literal("warn"),
          z.literal("info"),
          z.literal("debug"),
          z.literal("trace"),
        ])
        .optional(),
      consoleStyle: z
        .union([z.literal("pretty"), z.literal("compact"), z.literal("json")])
        .optional(),
    })
    .optional(),
  browser: z
    .object({
      enabled: z.boolean().optional(),
      controlUrl: z.string().optional(),
      color: z.string().optional(),
      headless: z.boolean().optional(),
      attachOnly: z.boolean().optional(),
    })
    .optional(),
  models: ModelsConfigSchema,
  agent: z
    .object({
      model: z.string().optional(),
      workspace: z.string().optional(),
      allowedModels: z.array(z.string()).optional(),
      modelAliases: z.record(z.string(), z.string()).optional(),
      contextTokens: z.number().int().positive().optional(),
      thinkingDefault: z
        .union([
          z.literal("off"),
          z.literal("minimal"),
          z.literal("low"),
          z.literal("medium"),
          z.literal("high"),
        ])
        .optional(),
      verboseDefault: z.union([z.literal("off"), z.literal("on")]).optional(),
      timeoutSeconds: z.number().int().positive().optional(),
      mediaMaxMb: z.number().positive().optional(),
      typingIntervalSeconds: z.number().int().positive().optional(),
      heartbeat: HeartbeatSchema,
      maxConcurrent: z.number().int().positive().optional(),
      bash: z
        .object({
          backgroundMs: z.number().int().positive().optional(),
          timeoutSec: z.number().int().positive().optional(),
          cleanupMs: z.number().int().positive().optional(),
        })
        .optional(),
    })
    .optional(),
  routing: RoutingSchema,
  messages: MessagesSchema,
  session: SessionSchema,
  cron: z
    .object({
      enabled: z.boolean().optional(),
      store: z.string().optional(),
      maxConcurrentRuns: z.number().int().positive().optional(),
    })
    .optional(),
  hooks: z
    .object({
      enabled: z.boolean().optional(),
      path: z.string().optional(),
      token: z.string().optional(),
      maxBodyBytes: z.number().int().positive().optional(),
      presets: z.array(z.string()).optional(),
      transformsDir: z.string().optional(),
      mappings: z.array(HookMappingSchema).optional(),
      gmail: HooksGmailSchema,
    })
    .optional(),
  web: z
    .object({
      enabled: z.boolean().optional(),
      heartbeatSeconds: z.number().int().positive().optional(),
      reconnect: z
        .object({
          initialMs: z.number().positive().optional(),
          maxMs: z.number().positive().optional(),
          factor: z.number().positive().optional(),
          jitter: z.number().min(0).max(1).optional(),
          maxAttempts: z.number().int().min(0).optional(),
        })
        .optional(),
    })
    .optional(),
  telegram: z
    .object({
      enabled: z.boolean().optional(),
      botToken: z.string().optional(),
      tokenFile: z.string().optional(),
      requireMention: z.boolean().optional(),
      allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
      mediaMaxMb: z.number().positive().optional(),
      proxy: z.string().optional(),
      webhookUrl: z.string().optional(),
      webhookSecret: z.string().optional(),
      webhookPath: z.string().optional(),
    })
    .optional(),
  discord: z
    .object({
      enabled: z.boolean().optional(),
      token: z.string().optional(),
      allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
      guildAllowFrom: z
        .object({
          guilds: z.array(z.union([z.string(), z.number()])).optional(),
          users: z.array(z.union([z.string(), z.number()])).optional(),
        })
        .optional(),
      requireMention: z.boolean().optional(),
      mediaMaxMb: z.number().positive().optional(),
    })
    .optional(),
  bridge: z
    .object({
      enabled: z.boolean().optional(),
      port: z.number().int().positive().optional(),
      bind: z
        .union([
          z.literal("auto"),
          z.literal("lan"),
          z.literal("tailnet"),
          z.literal("loopback"),
        ])
        .optional(),
    })
    .optional(),
  discovery: z
    .object({
      wideArea: z
        .object({
          enabled: z.boolean().optional(),
        })
        .optional(),
    })
    .optional(),
  canvasHost: z
    .object({
      enabled: z.boolean().optional(),
      root: z.string().optional(),
      port: z.number().int().positive().optional(),
    })
    .optional(),
  gateway: z
    .object({
      mode: z.union([z.literal("local"), z.literal("remote")]).optional(),
      bind: z
        .union([
          z.literal("auto"),
          z.literal("lan"),
          z.literal("tailnet"),
          z.literal("loopback"),
        ])
        .optional(),
      controlUi: z
        .object({
          enabled: z.boolean().optional(),
        })
        .optional(),
      auth: z
        .object({
          mode: z.union([z.literal("token"), z.literal("password")]).optional(),
          password: z.string().optional(),
          allowTailscale: z.boolean().optional(),
        })
        .optional(),
      tailscale: z
        .object({
          mode: z
            .union([z.literal("off"), z.literal("serve"), z.literal("funnel")])
            .optional(),
          resetOnExit: z.boolean().optional(),
        })
        .optional(),
    })
    .optional(),
  skillsLoad: z
    .object({
      extraDirs: z.array(z.string()).optional(),
    })
    .optional(),
  skillsInstall: z
    .object({
      preferBrew: z.boolean().optional(),
      nodeManager: z
        .union([z.literal("npm"), z.literal("pnpm"), z.literal("yarn")])
        .optional(),
    })
    .optional(),
  skills: z
    .record(
      z.string(),
      z
        .object({
          enabled: z.boolean().optional(),
          apiKey: z.string().optional(),
          env: z.record(z.string(), z.string()).optional(),
        })
        .passthrough(),
    )
    .optional(),
});

export type ConfigValidationIssue = {
  path: string;
  message: string;
};

export type ConfigFileSnapshot = {
  path: string;
  exists: boolean;
  raw: string | null;
  parsed: unknown;
  valid: boolean;
  config: ClawdisConfig;
  issues: ConfigValidationIssue[];
};

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function applyIdentityDefaults(cfg: ClawdisConfig): ClawdisConfig {
  const identity = cfg.identity;
  if (!identity) return cfg;

  const name = identity.name?.trim();

  const routing = cfg.routing ?? {};
  const groupChat = routing.groupChat ?? {};

  let mutated = false;
  const next: ClawdisConfig = { ...cfg };

  if (name && !groupChat.mentionPatterns) {
    const parts = name.split(/\s+/).filter(Boolean).map(escapeRegExp);
    const re = parts.length ? parts.join("\\s+") : escapeRegExp(name);
    const pattern = `\\b@?${re}\\b`;
    next.routing = {
      ...(next.routing ?? routing),
      groupChat: { ...groupChat, mentionPatterns: [pattern] },
    };
    mutated = true;
  }

  return mutated ? next : cfg;
}

export function loadConfig(): ClawdisConfig {
  // Read config file (JSON5) if present.
  const configPath = CONFIG_PATH_CLAWDIS;
  try {
    if (!fs.existsSync(configPath)) return {};
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON5.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const validated = ClawdisSchema.safeParse(parsed);
    if (!validated.success) {
      console.error("Invalid config:");
      for (const iss of validated.error.issues) {
        console.error(`- ${iss.path.join(".")}: ${iss.message}`);
      }
      return {};
    }
    return applyIdentityDefaults(validated.data as ClawdisConfig);
  } catch (err) {
    console.error(`Failed to read config at ${configPath}`, err);
    return {};
  }
}

export function validateConfigObject(
  raw: unknown,
):
  | { ok: true; config: ClawdisConfig }
  | { ok: false; issues: ConfigValidationIssue[] } {
  const validated = ClawdisSchema.safeParse(raw);
  if (!validated.success) {
    return {
      ok: false,
      issues: validated.error.issues.map((iss) => ({
        path: iss.path.join("."),
        message: iss.message,
      })),
    };
  }
  return {
    ok: true,
    config: applyIdentityDefaults(validated.data as ClawdisConfig),
  };
}

export function parseConfigJson5(
  raw: string,
): { ok: true; parsed: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, parsed: JSON5.parse(raw) as unknown };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export async function readConfigFileSnapshot(): Promise<ConfigFileSnapshot> {
  const configPath = CONFIG_PATH_CLAWDIS;
  const exists = fs.existsSync(configPath);
  if (!exists) {
    return {
      path: configPath,
      exists: false,
      raw: null,
      parsed: {},
      valid: true,
      config: {},
      issues: [],
    };
  }

  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsedRes = parseConfigJson5(raw);
    if (!parsedRes.ok) {
      return {
        path: configPath,
        exists: true,
        raw,
        parsed: {},
        valid: false,
        config: {},
        issues: [
          { path: "", message: `JSON5 parse failed: ${parsedRes.error}` },
        ],
      };
    }

    const validated = validateConfigObject(parsedRes.parsed);
    if (!validated.ok) {
      return {
        path: configPath,
        exists: true,
        raw,
        parsed: parsedRes.parsed,
        valid: false,
        config: {},
        issues: validated.issues,
      };
    }

    return {
      path: configPath,
      exists: true,
      raw,
      parsed: parsedRes.parsed,
      valid: true,
      config: validated.config,
      issues: [],
    };
  } catch (err) {
    return {
      path: configPath,
      exists: true,
      raw: null,
      parsed: {},
      valid: false,
      config: {},
      issues: [{ path: "", message: `read failed: ${String(err)}` }],
    };
  }
}

export async function writeConfigFile(cfg: ClawdisConfig) {
  await fs.promises.mkdir(path.dirname(CONFIG_PATH_CLAWDIS), {
    recursive: true,
  });
  const json = JSON.stringify(cfg, null, 2).trimEnd().concat("\n");
  await fs.promises.writeFile(CONFIG_PATH_CLAWDIS, json, "utf-8");
}
