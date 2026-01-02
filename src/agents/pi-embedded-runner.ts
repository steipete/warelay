import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AppMessage, ThinkingLevel } from "@mariozechner/pi-agent-core";
import {
  type Api,
  type AssistantMessage,
  getEnvApiKey,
  getOAuthApiKey,
  type Model,
  type OAuthCredentials,
  type OAuthProvider,
} from "@mariozechner/pi-ai";
import {
  buildSystemPrompt,
  createAgentSession,
  discoverAuthStorage,
  discoverModels,
  SessionManager,
  SettingsManager,
  type Skill,
} from "@mariozechner/pi-coding-agent";
import type { ThinkLevel, VerboseLevel } from "../auto-reply/thinking.js";
import { formatToolAggregate } from "../auto-reply/tool-meta.js";
import type { ClawdisConfig } from "../config/config.js";
import { getMachineDisplayName } from "../infra/machine-name.js";
import { splitMediaFromOutput } from "../media/parse.js";
import {
  type enqueueCommand,
  enqueueCommandInLane,
} from "../process/command-queue.js";
import { CONFIG_DIR, resolveUserPath } from "../utils.js";
import { resolveClawdisAgentDir } from "./agent-paths.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import { loadModelCatalog } from "./model-catalog.js";
import {
  buildAllowedModelSet,
  buildModelAliasIndex,
  modelKey,
  resolveConfiguredModelRef,
  resolveModelRefFromString,
  type ModelRef,
} from "./model-selection.js";
import { ensureClawdisModelsJson } from "./models-config.js";
import {
  buildBootstrapContextFiles,
  ensureSessionHeader,
  formatAssistantErrorText,
  sanitizeSessionMessagesImages,
  sanitizeSessionMessagesForGoogle,
} from "./pi-embedded-helpers.js";
import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";
import { extractAssistantText } from "./pi-embedded-utils.js";
import { createClawdisCodingTools } from "./pi-tools.js";
import {
  applySkillEnvOverrides,
  applySkillEnvOverridesFromSnapshot,
  buildWorkspaceSkillSnapshot,
  loadWorkspaceSkillEntries,
  type SkillEntry,
  type SkillSnapshot,
} from "./skills.js";
import { buildAgentSystemPromptAppend } from "./system-prompt.js";
import { loadWorkspaceBootstrapFiles } from "./workspace.js";

export type EmbeddedPiAgentMeta = {
  sessionId: string;
  provider: string;
  model: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
};

export type EmbeddedPiRunMeta = {
  durationMs: number;
  agentMeta?: EmbeddedPiAgentMeta;
  aborted?: boolean;
  stopReason?: string;
  errorMessage?: string;
};

export type EmbeddedPiRunResult = {
  payloads?: Array<{
    text?: string;
    mediaUrl?: string;
    mediaUrls?: string[];
  }>;
  meta: EmbeddedPiRunMeta;
};

type EmbeddedPiQueueHandle = {
  queueMessage: (text: string) => Promise<void>;
  isStreaming: () => boolean;
  abort: () => void;
};

const ACTIVE_EMBEDDED_RUNS = new Map<string, EmbeddedPiQueueHandle>();

const OAUTH_FILENAME = "oauth.json";
const DEFAULT_OAUTH_DIR = path.join(CONFIG_DIR, "credentials");
let oauthStorageConfigured = false;

type OAuthStorage = Record<string, OAuthCredentials>;

function resolveSessionLane(key: string) {
  const cleaned = key.trim() || "main";
  return cleaned.startsWith("session:") ? cleaned : `session:${cleaned}`;
}

function resolveGlobalLane(lane?: string) {
  const cleaned = lane?.trim();
  return cleaned ? cleaned : "main";
}

function resolveClawdisOAuthPath(): string {
  const overrideDir =
    process.env.CLAWDIS_OAUTH_DIR?.trim() || DEFAULT_OAUTH_DIR;
  return path.join(resolveUserPath(overrideDir), OAUTH_FILENAME);
}

function loadOAuthStorageAt(pathname: string): OAuthStorage | null {
  if (!fsSync.existsSync(pathname)) return null;
  try {
    const content = fsSync.readFileSync(pathname, "utf8");
    const json = JSON.parse(content) as OAuthStorage;
    if (!json || typeof json !== "object") return null;
    return json;
  } catch {
    return null;
  }
}

function hasAnthropicOAuth(storage: OAuthStorage): boolean {
  const entry = storage.anthropic as
    | {
        refresh?: string;
        refresh_token?: string;
        refreshToken?: string;
        access?: string;
        access_token?: string;
        accessToken?: string;
      }
    | undefined;
  if (!entry) return false;
  const refresh =
    entry.refresh ?? entry.refresh_token ?? entry.refreshToken ?? "";
  const access = entry.access ?? entry.access_token ?? entry.accessToken ?? "";
  return Boolean(refresh.trim() && access.trim());
}

function saveOAuthStorageAt(pathname: string, storage: OAuthStorage): void {
  const dir = path.dirname(pathname);
  fsSync.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fsSync.writeFileSync(
    pathname,
    `${JSON.stringify(storage, null, 2)}\n`,
    "utf8",
  );
  fsSync.chmodSync(pathname, 0o600);
}

function legacyOAuthPaths(): string[] {
  const paths: string[] = [];
  const piOverride = process.env.PI_CODING_AGENT_DIR?.trim();
  if (piOverride) {
    paths.push(path.join(resolveUserPath(piOverride), OAUTH_FILENAME));
  }
  paths.push(path.join(os.homedir(), ".pi", "agent", OAUTH_FILENAME));
  paths.push(path.join(os.homedir(), ".claude", OAUTH_FILENAME));
  paths.push(path.join(os.homedir(), ".config", "claude", OAUTH_FILENAME));
  paths.push(path.join(os.homedir(), ".config", "anthropic", OAUTH_FILENAME));
  return Array.from(new Set(paths));
}

function importLegacyOAuthIfNeeded(destPath: string): void {
  if (fsSync.existsSync(destPath)) return;
  for (const legacyPath of legacyOAuthPaths()) {
    const storage = loadOAuthStorageAt(legacyPath);
    if (!storage || !hasAnthropicOAuth(storage)) continue;
    saveOAuthStorageAt(destPath, storage);
    return;
  }
}

function ensureOAuthStorage(): void {
  if (oauthStorageConfigured) return;
  oauthStorageConfigured = true;
  const oauthPath = resolveClawdisOAuthPath();
  importLegacyOAuthIfNeeded(oauthPath);
}

function isOAuthProvider(provider: string): provider is OAuthProvider {
  return (
    provider === "anthropic" ||
    provider === "github-copilot" ||
    provider === "google-gemini-cli" ||
    provider === "google-antigravity"
  );
}

async function resolveFailoverModels(params: {
  config?: ClawdisConfig;
  primaryProvider: string;
  primaryModel: string;
}): Promise<ModelRef[]> {
  const cfg = params.config;
  const rawList = cfg?.agent?.failoverModels ?? [];
  if (rawList.length === 0) return [];

  const primaryKey = modelKey(params.primaryProvider, params.primaryModel);
  const aliasDefaultProvider = cfg
    ? resolveConfiguredModelRef({
        cfg,
        defaultProvider: DEFAULT_PROVIDER,
        defaultModel: DEFAULT_MODEL,
      }).provider
    : params.primaryProvider;
  const aliasIndex = cfg
    ? buildModelAliasIndex({ cfg, defaultProvider: aliasDefaultProvider })
    : undefined;

  let allowedModelKeys = new Set<string>();
  const hasAllowlist = (cfg?.agent?.allowedModels?.length ?? 0) > 0;
  if (cfg && hasAllowlist) {
    const catalog = await loadModelCatalog({ config: cfg });
    const allowed = buildAllowedModelSet({
      cfg,
      catalog,
      defaultProvider: aliasDefaultProvider,
    });
    allowedModelKeys = allowed.allowedKeys;
  }

  const seen = new Set<string>();
  const results: ModelRef[] = [];
  for (const raw of rawList) {
    const value = String(raw ?? "").trim();
    if (!value) continue;
    const resolved = resolveModelRefFromString({
      raw: value,
      defaultProvider: params.primaryProvider,
      aliasIndex,
    });
    if (!resolved) continue;
    const key = modelKey(resolved.ref.provider, resolved.ref.model);
    if (key === primaryKey || seen.has(key)) continue;
    if (allowedModelKeys.size > 0 && !allowedModelKeys.has(key)) continue;
    results.push(resolved.ref);
    seen.add(key);
  }

  return results;
}

export async function runEmbeddedPiAgent(
  params: EmbeddedPiRunParams,
): Promise<EmbeddedPiRunResult> {
  const primaryProvider =
    (params.provider ?? DEFAULT_PROVIDER).trim() || DEFAULT_PROVIDER;
  const primaryModel =
    (params.model ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const failoverModels = await resolveFailoverModels({
    config: params.config,
    primaryProvider,
    primaryModel,
  });

  if (failoverModels.length === 0) {
    return runEmbeddedPiAgentOnce({
      ...params,
      provider: primaryProvider,
      model: primaryModel,
    });
  }

  const attempts = [
    { provider: primaryProvider, model: primaryModel },
    ...failoverModels,
  ];
  const errors: string[] = [];

  for (let index = 0; index < attempts.length; index++) {
    const attempt = attempts[index];
    let streamed = false;
    const onPartialReply = params.onPartialReply
      ? (payload: { text?: string; mediaUrls?: string[] }) => {
          streamed = true;
          return params.onPartialReply?.(payload);
        }
      : undefined;
    const onToolResult = params.onToolResult
      ? (payload: { text?: string; mediaUrls?: string[] }) => {
          streamed = true;
          return params.onToolResult?.(payload);
        }
      : undefined;
    const onAgentEvent = params.onAgentEvent;

    try {
      const result = await runEmbeddedPiAgentOnce({
        ...params,
        provider: attempt.provider,
        model: attempt.model,
        onPartialReply,
        onToolResult,
        onAgentEvent,
      });
      if (result.meta.aborted || params.abortSignal?.aborted) {
        return result;
      }
      if (
        result.meta.stopReason === "error" &&
        !streamed &&
        index < attempts.length - 1
      ) {
        errors.push(
          `${attempt.provider}/${attempt.model}: ${result.meta.errorMessage ?? "unknown error"}`,
        );
        continue;
      }
      return result;
    } catch (err) {
      if (params.abortSignal?.aborted) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${attempt.provider}/${attempt.model}: ${message}`);
      if (streamed || index === attempts.length - 1) {
        throw err;
      }
    }
  }

  throw new Error(
    errors.length > 0
      ? `All models failed: ${errors.join("; ")}`
      : "All models failed.",
  );
}

export function queueEmbeddedPiMessage(
  sessionId: string,
  text: string,
): boolean {
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  if (!handle) return false;
  if (!handle.isStreaming()) return false;
  void handle.queueMessage(text);
  return true;
}

export function abortEmbeddedPiRun(sessionId: string): boolean {
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  if (!handle) return false;
  handle.abort();
  return true;
}

export function isEmbeddedPiRunActive(sessionId: string): boolean {
  return ACTIVE_EMBEDDED_RUNS.has(sessionId);
}

export function isEmbeddedPiRunStreaming(sessionId: string): boolean {
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  if (!handle) return false;
  return handle.isStreaming();
}

export function resolveEmbeddedSessionLane(key: string) {
  return resolveSessionLane(key);
}

function mapThinkingLevel(level?: ThinkLevel): ThinkingLevel {
  // pi-agent-core supports "xhigh" too; Clawdis doesn't surface it for now.
  if (!level) return "off";
  return level;
}

function resolveModel(
  provider: string,
  modelId: string,
  agentDir?: string,
): {
  model?: Model<Api>;
  error?: string;
  authStorage: ReturnType<typeof discoverAuthStorage>;
  modelRegistry: ReturnType<typeof discoverModels>;
} {
  const resolvedAgentDir = agentDir ?? resolveClawdisAgentDir();
  const authStorage = discoverAuthStorage(resolvedAgentDir);
  const modelRegistry = discoverModels(authStorage, resolvedAgentDir);
  const model = modelRegistry.find(provider, modelId) as Model<Api> | null;
  if (!model) {
    return {
      error: `Unknown model: ${provider}/${modelId}`,
      authStorage,
      modelRegistry,
    };
  }
  return { model, authStorage, modelRegistry };
}

async function getApiKeyForModel(
  model: Model<Api>,
  authStorage: ReturnType<typeof discoverAuthStorage>,
): Promise<string> {
  const storedKey = await authStorage.getApiKey(model.provider);
  if (storedKey) return storedKey;
  ensureOAuthStorage();
  if (model.provider === "anthropic") {
    const oauthEnv = process.env.ANTHROPIC_OAUTH_TOKEN;
    if (oauthEnv?.trim()) return oauthEnv.trim();
  }
  const envKey = getEnvApiKey(model.provider);
  if (envKey) return envKey;
  if (isOAuthProvider(model.provider)) {
    const oauthPath = resolveClawdisOAuthPath();
    const storage = loadOAuthStorageAt(oauthPath);
    if (storage) {
      try {
        const result = await getOAuthApiKey(model.provider, storage);
        if (result?.apiKey) {
          storage[model.provider] = result.newCredentials;
          saveOAuthStorageAt(oauthPath, storage);
          return result.apiKey;
        }
      } catch {
        // fall through to error below
      }
    }
  }
  throw new Error(`No API key found for provider "${model.provider}"`);
}

function resolvePromptSkills(
  snapshot: SkillSnapshot,
  entries: SkillEntry[],
): Skill[] {
  if (snapshot.resolvedSkills?.length) {
    return snapshot.resolvedSkills;
  }

  const snapshotNames = snapshot.skills.map((entry) => entry.name);
  if (snapshotNames.length === 0) return [];

  const entryByName = new Map(
    entries.map((entry) => [entry.skill.name, entry.skill]),
  );
  return snapshotNames
    .map((name) => entryByName.get(name))
    .filter((skill): skill is Skill => Boolean(skill));
}

type EmbeddedPiRunParams = {
  sessionId: string;
  sessionKey?: string;
  sessionFile: string;
  workspaceDir: string;
  config?: ClawdisConfig;
  skillsSnapshot?: SkillSnapshot;
  prompt: string;
  provider?: string;
  model?: string;
  thinkLevel?: ThinkLevel;
  verboseLevel?: VerboseLevel;
  timeoutMs: number;
  runId: string;
  abortSignal?: AbortSignal;
  shouldEmitToolResult?: () => boolean;
  onPartialReply?: (payload: {
    text?: string;
    mediaUrls?: string[];
  }) => void | Promise<void>;
  onToolResult?: (payload: {
    text?: string;
    mediaUrls?: string[];
  }) => void | Promise<void>;
  onAgentEvent?: (evt: {
    stream: string;
    data: Record<string, unknown>;
  }) => void;
  lane?: string;
  enqueue?: typeof enqueueCommand;
  extraSystemPrompt?: string;
  ownerNumbers?: string[];
  enforceFinalTag?: boolean;
};

async function runEmbeddedPiAgentOnce(
  params: EmbeddedPiRunParams,
): Promise<EmbeddedPiRunResult> {
  const sessionLane = resolveSessionLane(
    params.sessionKey?.trim() || params.sessionId,
  );
  const globalLane = resolveGlobalLane(params.lane);
  const enqueueGlobal =
    params.enqueue ??
    ((task, opts) => enqueueCommandInLane(globalLane, task, opts));
  return enqueueCommandInLane(sessionLane, () =>
    enqueueGlobal(async () => {
      const started = Date.now();
      const resolvedWorkspace = resolveUserPath(params.workspaceDir);
      const prevCwd = process.cwd();

      const provider =
        (params.provider ?? DEFAULT_PROVIDER).trim() || DEFAULT_PROVIDER;
      const modelId = (params.model ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;
      await ensureClawdisModelsJson(params.config);
      const agentDir = resolveClawdisAgentDir();
      const { model, error, authStorage, modelRegistry } = resolveModel(
        provider,
        modelId,
        agentDir,
      );
      if (!model) {
        throw new Error(error ?? `Unknown model: ${provider}/${modelId}`);
      }
      const apiKey = await getApiKeyForModel(model, authStorage);
      authStorage.setRuntimeApiKey(model.provider, apiKey);

      const thinkingLevel = mapThinkingLevel(params.thinkLevel);

      await fs.mkdir(resolvedWorkspace, { recursive: true });
      await ensureSessionHeader({
        sessionFile: params.sessionFile,
        sessionId: params.sessionId,
        cwd: resolvedWorkspace,
      });

      let restoreSkillEnv: (() => void) | undefined;
      process.chdir(resolvedWorkspace);
      try {
        const shouldLoadSkillEntries =
          !params.skillsSnapshot || !params.skillsSnapshot.resolvedSkills;
        const skillEntries = shouldLoadSkillEntries
          ? loadWorkspaceSkillEntries(resolvedWorkspace)
          : [];
        const skillsSnapshot =
          params.skillsSnapshot ??
          buildWorkspaceSkillSnapshot(resolvedWorkspace, {
            config: params.config,
            entries: skillEntries,
          });
        restoreSkillEnv = params.skillsSnapshot
          ? applySkillEnvOverridesFromSnapshot({
              snapshot: params.skillsSnapshot,
              config: params.config,
            })
          : applySkillEnvOverrides({
              skills: skillEntries ?? [],
              config: params.config,
            });

        const bootstrapFiles =
          await loadWorkspaceBootstrapFiles(resolvedWorkspace);
        const contextFiles = buildBootstrapContextFiles(bootstrapFiles);
        const promptSkills = resolvePromptSkills(skillsSnapshot, skillEntries);
        const modelApi =
          model && typeof model === "object" && "api" in model
            ? (model as { api?: string }).api
            : undefined;
        const isGoogleModel =
          modelApi === "google-generative-ai" || provider === "google";
        const tools = createClawdisCodingTools({
          bash: params.config?.agent?.bash,
          stripAnyOf: isGoogleModel,
          sanitizeForGoogle: isGoogleModel,
        });
        const machineName = await getMachineDisplayName();
        const runtimeInfo = {
          host: machineName,
          os: `${os.type()} ${os.release()}`,
          arch: os.arch(),
          node: process.version,
          model: `${provider}/${modelId}`,
        };
        const reasoningTagHint = provider === "ollama";
        const systemPrompt = buildSystemPrompt({
          appendPrompt: buildAgentSystemPromptAppend({
            workspaceDir: resolvedWorkspace,
            defaultThinkLevel: params.thinkLevel,
            extraSystemPrompt: params.extraSystemPrompt,
            ownerNumbers: params.ownerNumbers,
            reasoningTagHint,
            runtimeInfo,
          }),
          contextFiles,
          skills: promptSkills,
          cwd: resolvedWorkspace,
          tools,
        });

        const sessionManager = SessionManager.open(params.sessionFile);
        const settingsManager = SettingsManager.create(
          resolvedWorkspace,
          agentDir,
        );

        const { session } = await createAgentSession({
          cwd: resolvedWorkspace,
          agentDir,
          authStorage,
          modelRegistry,
          model,
          thinkingLevel,
          systemPrompt,
          // TODO(steipete): Once pi-mono publishes file-magic MIME detection in `read` image payloads,
          // remove `createClawdisCodingTools()` and use upstream `codingTools` again.
          tools,
          sessionManager,
          settingsManager,
          skills: promptSkills,
          contextFiles,
        });

        let prior = await sanitizeSessionMessagesImages(
          session.messages,
          "session:history",
        );
        if (isGoogleModel) {
          prior = sanitizeSessionMessagesForGoogle(prior);
        }
        if (prior.length > 0) {
          session.agent.replaceMessages(prior);
        }
        let aborted = Boolean(params.abortSignal?.aborted);
        const abortRun = () => {
          aborted = true;
          void session.abort();
        };
        const queueHandle: EmbeddedPiQueueHandle = {
          queueMessage: async (text: string) => {
            await session.queueMessage(text);
          },
          isStreaming: () => session.isStreaming,
          abort: abortRun,
        };
        ACTIVE_EMBEDDED_RUNS.set(params.sessionId, queueHandle);

        const {
          assistantTexts,
          toolMetas,
          unsubscribe,
          flush: flushToolDebouncer,
          waitForCompactionRetry,
        } = subscribeEmbeddedPiSession({
          session,
          runId: params.runId,
          verboseLevel: params.verboseLevel,
          shouldEmitToolResult: params.shouldEmitToolResult,
          onToolResult: params.onToolResult,
          onPartialReply: params.onPartialReply,
          onAgentEvent: params.onAgentEvent,
          enforceFinalTag: params.enforceFinalTag,
        });

        const abortTimer = setTimeout(
          () => {
            abortRun();
          },
          Math.max(1, params.timeoutMs),
        );

        let messagesSnapshot: AppMessage[] = [];
        let sessionIdUsed = session.sessionId;
        const onAbort = () => {
          abortRun();
        };
        if (params.abortSignal) {
          if (params.abortSignal.aborted) {
            onAbort();
          } else {
            params.abortSignal.addEventListener("abort", onAbort, {
              once: true,
            });
          }
        }
        let promptError: unknown = null;
        try {
          try {
            await session.prompt(params.prompt);
          } catch (err) {
            promptError = err;
          }
          await waitForCompactionRetry();
          messagesSnapshot = session.messages.slice();
          sessionIdUsed = session.sessionId;
        } finally {
          clearTimeout(abortTimer);
          unsubscribe();
          flushToolDebouncer();
          if (ACTIVE_EMBEDDED_RUNS.get(params.sessionId) === queueHandle) {
            ACTIVE_EMBEDDED_RUNS.delete(params.sessionId);
          }
          session.dispose();
          params.abortSignal?.removeEventListener?.("abort", onAbort);
        }
        if (promptError && !aborted) {
          throw promptError;
        }

        const lastAssistant = messagesSnapshot
          .slice()
          .reverse()
          .find((m) => (m as AppMessage)?.role === "assistant") as
          | AssistantMessage
          | undefined;

        const stopReason = lastAssistant?.stopReason;
        const errorMessage = lastAssistant?.errorMessage?.trim() || undefined;

        const usage = lastAssistant?.usage;
        const agentMeta: EmbeddedPiAgentMeta = {
          sessionId: sessionIdUsed,
          provider: lastAssistant?.provider ?? provider,
          model: lastAssistant?.model ?? model.id,
          usage: usage
            ? {
                input: usage.input,
                output: usage.output,
                cacheRead: usage.cacheRead,
                cacheWrite: usage.cacheWrite,
                total: usage.totalTokens,
              }
            : undefined,
        };

        const replyItems: Array<{ text: string; media?: string[] }> = [];

        const errorText = lastAssistant
          ? formatAssistantErrorText(lastAssistant)
          : undefined;
        if (errorText) replyItems.push({ text: errorText });

        const inlineToolResults =
          params.verboseLevel === "on" &&
          !params.onPartialReply &&
          !params.onToolResult &&
          toolMetas.length > 0;
        if (inlineToolResults) {
          for (const { toolName, meta } of toolMetas) {
            const agg = formatToolAggregate(toolName, meta ? [meta] : []);
            const { text: cleanedText, mediaUrls } = splitMediaFromOutput(agg);
            if (cleanedText)
              replyItems.push({ text: cleanedText, media: mediaUrls });
          }
        }

        for (const text of assistantTexts.length
          ? assistantTexts
          : lastAssistant
            ? [extractAssistantText(lastAssistant)]
            : []) {
          const { text: cleanedText, mediaUrls } = splitMediaFromOutput(text);
          if (!cleanedText && (!mediaUrls || mediaUrls.length === 0)) continue;
          replyItems.push({ text: cleanedText, media: mediaUrls });
        }

        const payloads = replyItems
          .map((item) => ({
            text: item.text?.trim() ? item.text.trim() : undefined,
            mediaUrls: item.media?.length ? item.media : undefined,
            mediaUrl: item.media?.[0],
          }))
          .filter(
            (p) =>
              p.text || p.mediaUrl || (p.mediaUrls && p.mediaUrls.length > 0),
          );

        return {
          payloads: payloads.length ? payloads : undefined,
          meta: {
            durationMs: Date.now() - started,
            agentMeta,
            aborted,
            stopReason,
            errorMessage,
          },
        };
      } finally {
        restoreSkillEnv?.();
        process.chdir(prevCwd);
      }
    }),
  );
}
