import crypto from "node:crypto";
import { chunkText } from "../auto-reply/chunk.js";
import { runCommandReply } from "../auto-reply/command-reply.js";
import {
  applyTemplate,
  type MsgContext,
  type TemplateContext,
} from "../auto-reply/templating.js";
import {
  normalizeThinkLevel,
  normalizeVerboseLevel,
  type ThinkLevel,
  type VerboseLevel,
} from "../auto-reply/thinking.js";
import { type CliDeps, createDefaultDeps } from "../cli/deps.js";
import { type ClawdisConfig, loadConfig } from "../config/config.js";
import {
  DEFAULT_IDLE_MINUTES,
  loadSessionStore,
  resolveSessionKey,
  resolveStorePath,
  type SessionEntry,
  saveSessionStore,
} from "../config/sessions.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { normalizeE164 } from "../utils.js";

type AgentCommandOpts = {
  message: string;
  to?: string;
  sessionId?: string;
  thinking?: string;
  thinkingOnce?: string;
  verbose?: string;
  json?: boolean;
  timeout?: string;
  deliver?: boolean;
  surface?: string;
  provider?: string;
  bestEffortDeliver?: boolean;
};

type SessionResolution = {
  sessionId: string;
  sessionKey?: string;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  storePath?: string;
  isNewSession: boolean;
  systemSent: boolean;
  persistedThinking?: ThinkLevel;
  persistedVerbose?: VerboseLevel;
};

function assertCommandConfig(cfg: ClawdisConfig) {
  const reply = cfg.inbound?.reply;
  if (!reply || reply.mode !== "command" || !reply.command?.length) {
    throw new Error(
      "Configure inbound.reply.mode=command with reply.command before using `clawdis agent`.",
    );
  }
  return reply as NonNullable<
    NonNullable<ClawdisConfig["inbound"]>["reply"]
  > & { mode: "command"; command: string[] };
}

function resolveSession(opts: {
  to?: string;
  sessionId?: string;
  replyCfg: NonNullable<NonNullable<ClawdisConfig["inbound"]>["reply"]>;
}): SessionResolution {
  const sessionCfg = opts.replyCfg?.session;
  const scope = sessionCfg?.scope ?? "per-sender";
  const mainKey = sessionCfg?.mainKey ?? "main";
  const idleMinutes = Math.max(
    sessionCfg?.idleMinutes ?? DEFAULT_IDLE_MINUTES,
    1,
  );
  const idleMs = idleMinutes * 60_000;
  const storePath = sessionCfg ? resolveStorePath(sessionCfg.store) : undefined;
  const sessionStore = storePath ? loadSessionStore(storePath) : undefined;
  const now = Date.now();

  let sessionKey: string | undefined =
    sessionStore && opts.to
      ? resolveSessionKey(scope, { From: opts.to } as MsgContext, mainKey)
      : undefined;
  let sessionEntry =
    sessionKey && sessionStore ? sessionStore[sessionKey] : undefined;

  // If a session id was provided, prefer to re-use its entry (by id) even when no key was derived.
  if (
    sessionStore &&
    opts.sessionId &&
    (!sessionEntry || sessionEntry.sessionId !== opts.sessionId)
  ) {
    const foundKey = Object.keys(sessionStore).find(
      (key) => sessionStore[key]?.sessionId === opts.sessionId,
    );
    if (foundKey) {
      sessionKey = sessionKey ?? foundKey;
      sessionEntry = sessionStore[foundKey];
    }
  }

  let sessionId = opts.sessionId?.trim() || sessionEntry?.sessionId;
  let isNewSession = false;
  let systemSent = sessionEntry?.systemSent ?? false;

  if (!opts.sessionId) {
    const fresh = sessionEntry && sessionEntry.updatedAt >= now - idleMs;
    if (!sessionEntry || !fresh) {
      sessionId = sessionId ?? crypto.randomUUID();
      isNewSession = true;
      systemSent = false;
      if (sessionCfg && sessionStore && sessionKey) {
        sessionEntry = {
          sessionId,
          updatedAt: now,
          abortedLastRun: sessionEntry?.abortedLastRun,
        };
      }
    }
  } else {
    sessionId = sessionId ?? crypto.randomUUID();
    isNewSession = false;
    if (!sessionEntry && sessionCfg && sessionStore && sessionKey) {
      sessionEntry = {
        sessionId,
        updatedAt: now,
      };
    }
  }

  const persistedThinking =
    !isNewSession && sessionEntry
      ? normalizeThinkLevel(sessionEntry.thinkingLevel)
      : undefined;
  const persistedVerbose =
    !isNewSession && sessionEntry
      ? normalizeVerboseLevel(sessionEntry.verboseLevel)
      : undefined;

  return {
    sessionId: sessionId ?? crypto.randomUUID(),
    sessionKey,
    sessionEntry,
    sessionStore,
    storePath,
    isNewSession,
    systemSent,
    persistedThinking,
    persistedVerbose,
  };
}

export async function agentCommand(
  opts: AgentCommandOpts,
  runtime: RuntimeEnv = defaultRuntime,
  deps: CliDeps = createDefaultDeps(),
) {
  const body = (opts.message ?? "").trim();
  if (!body) {
    throw new Error("Message (--message) is required");
  }
  if (!opts.to && !opts.sessionId) {
    throw new Error("Pass --to <E.164> or --session-id to choose a session");
  }

  const cfg = loadConfig();
  const replyCfg = assertCommandConfig(cfg);
  const sessionCfg = replyCfg.session;
  const allowFrom = (cfg.inbound?.allowFrom ?? [])
    .map((val) => normalizeE164(val))
    .filter((val) => val.length > 1);

  const thinkOverride = normalizeThinkLevel(opts.thinking);
  const thinkOnce = normalizeThinkLevel(opts.thinkingOnce);
  if (opts.thinking && !thinkOverride) {
    throw new Error(
      "Invalid thinking level. Use one of: off, minimal, low, medium, high.",
    );
  }
  if (opts.thinkingOnce && !thinkOnce) {
    throw new Error(
      "Invalid one-shot thinking level. Use one of: off, minimal, low, medium, high.",
    );
  }
  const verboseOverride = normalizeVerboseLevel(opts.verbose);
  if (opts.verbose && !verboseOverride) {
    throw new Error('Invalid verbose level. Use "on" or "off".');
  }

  const timeoutSecondsRaw =
    opts.timeout !== undefined
      ? Number.parseInt(String(opts.timeout), 10)
      : (replyCfg.timeoutSeconds ?? 600);
  const timeoutSeconds = Math.max(timeoutSecondsRaw, 1);
  if (Number.isNaN(timeoutSecondsRaw) || timeoutSecondsRaw <= 0) {
    throw new Error("--timeout must be a positive integer (seconds)");
  }
  const timeoutMs = timeoutSeconds * 1000;

  const sessionResolution = resolveSession({
    to: opts.to,
    sessionId: opts.sessionId,
    replyCfg,
  });
  const {
    sessionId,
    sessionKey,
    sessionEntry,
    sessionStore,
    storePath,
    isNewSession,
    systemSent: initialSystemSent,
    persistedThinking,
    persistedVerbose,
  } = sessionResolution;

  let systemSent = initialSystemSent;
  const sendSystemOnce = sessionCfg?.sendSystemOnce === true;
  const isFirstTurnInSession = isNewSession || !systemSent;

  // Merge thinking/verbose levels: one-shot override > flag override > persisted > defaults.
  const resolvedThinkLevel: ThinkLevel | undefined =
    thinkOnce ??
    thinkOverride ??
    persistedThinking ??
    (replyCfg.thinkingDefault as ThinkLevel | undefined);
  const resolvedVerboseLevel: VerboseLevel | undefined =
    verboseOverride ??
    persistedVerbose ??
    (replyCfg.verboseDefault as VerboseLevel | undefined);

  // Persist overrides into the session store (mirrors directive-only flow).
  if (sessionStore && sessionEntry && sessionKey && storePath) {
    sessionEntry.updatedAt = Date.now();
    if (thinkOverride) {
      if (thinkOverride === "off") {
        delete sessionEntry.thinkingLevel;
      } else {
        sessionEntry.thinkingLevel = thinkOverride;
      }
    } else if (isNewSession) {
      delete sessionEntry.thinkingLevel;
    }

    if (verboseOverride) {
      if (verboseOverride === "off") {
        delete sessionEntry.verboseLevel;
      } else {
        sessionEntry.verboseLevel = verboseOverride;
      }
    } else if (isNewSession) {
      delete sessionEntry.verboseLevel;
    }

    if (sendSystemOnce && isFirstTurnInSession) {
      sessionEntry.systemSent = true;
      systemSent = true;
    }

    sessionStore[sessionKey] = sessionEntry;
    await saveSessionStore(storePath, sessionStore);
  }

  const baseCtx: TemplateContext = {
    Body: body,
    BodyStripped: body,
    From: opts.to,
    SessionId: sessionId,
    IsNewSession: isNewSession ? "true" : "false",
    Surface: opts.surface,
  };

  const sessionIntro =
    isFirstTurnInSession && sessionCfg?.sessionIntro
      ? applyTemplate(sessionCfg.sessionIntro, baseCtx)
      : "";
  const bodyPrefix = replyCfg.bodyPrefix
    ? applyTemplate(replyCfg.bodyPrefix, baseCtx)
    : "";

  let commandBody = body;
  if (!sendSystemOnce || isFirstTurnInSession) {
    commandBody = bodyPrefix ? `${bodyPrefix}${commandBody}` : commandBody;
  }
  if (sessionIntro) {
    commandBody = `${sessionIntro}\n\n${commandBody}`;
  }

  const templatingCtx: TemplateContext = {
    ...baseCtx,
    Body: commandBody,
    BodyStripped: commandBody,
  };

  const startedAt = Date.now();
  emitAgentEvent({
    runId: sessionId,
    stream: "job",
    data: {
      state: "started",
      startedAt,
      to: opts.to,
      sessionId,
      isNewSession,
    },
  });

  let result: Awaited<ReturnType<typeof runCommandReply>>;
  try {
    result = await runCommandReply({
      reply: { ...replyCfg, mode: "command" },
      templatingCtx,
      sendSystemOnce,
      isNewSession,
      isFirstTurnInSession,
      systemSent,
      timeoutMs,
      timeoutSeconds,
      thinkLevel: resolvedThinkLevel,
      verboseLevel: resolvedVerboseLevel,
      runId: sessionId,
      onAgentEvent: (evt) => {
        emitAgentEvent({
          runId: sessionId,
          stream: evt.stream,
          data: evt.data,
        });
      },
    });
    emitAgentEvent({
      runId: sessionId,
      stream: "job",
      data: {
        state: "done",
        startedAt,
        endedAt: Date.now(),
        to: opts.to,
        sessionId,
        durationMs: Date.now() - startedAt,
      },
    });
  } catch (err) {
    emitAgentEvent({
      runId: sessionId,
      stream: "job",
      data: {
        state: "error",
        startedAt,
        endedAt: Date.now(),
        to: opts.to,
        sessionId,
        durationMs: Date.now() - startedAt,
        error: String(err),
      },
    });
    throw err;
  }

  // If the agent returned a new session id, persist it.
  const returnedSessionId = result.meta.agentMeta?.sessionId;
  if (
    returnedSessionId &&
    returnedSessionId !== sessionId &&
    sessionStore &&
    sessionEntry &&
    sessionKey &&
    storePath
  ) {
    sessionEntry.sessionId = returnedSessionId;
    sessionEntry.updatedAt = Date.now();
    sessionStore[sessionKey] = sessionEntry;
    await saveSessionStore(storePath, sessionStore);
  }

  const payloads = result.payloads ?? [];
  const deliver = opts.deliver === true;
  const bestEffortDeliver = opts.bestEffortDeliver === true;
  const provider = (opts.provider ?? "whatsapp").toLowerCase();

  const whatsappTarget = opts.to ? normalizeE164(opts.to) : allowFrom[0];
  const telegramTarget = opts.to?.trim() || undefined;

  const logDeliveryError = (err: unknown) => {
    const message = `Delivery failed (${provider}): ${String(err)}`;
    runtime.error?.(message);
    if (!runtime.error) runtime.log(message);
  };

  if (deliver) {
    if (provider === "whatsapp" && !whatsappTarget) {
      const err = new Error(
        "Delivering to WhatsApp requires --to <E.164> or inbound.allowFrom[0]",
      );
      if (!bestEffortDeliver) throw err;
      logDeliveryError(err);
    }
    if (provider === "telegram" && !telegramTarget) {
      const err = new Error("Delivering to Telegram requires --to <chatId>");
      if (!bestEffortDeliver) throw err;
      logDeliveryError(err);
    }
    if (provider === "webchat") {
      const err = new Error(
        "Delivering to WebChat is not supported via `clawdis agent`; use WebChat RPC instead.",
      );
      if (!bestEffortDeliver) throw err;
      logDeliveryError(err);
    }
    if (
      provider !== "whatsapp" &&
      provider !== "telegram" &&
      provider !== "webchat"
    ) {
      const err = new Error(`Unknown provider: ${provider}`);
      if (!bestEffortDeliver) throw err;
      logDeliveryError(err);
    }
  }

  if (opts.json) {
    const normalizedPayloads = payloads.map((p) => ({
      text: p.text ?? "",
      mediaUrl: p.mediaUrl ?? null,
      mediaUrls: p.mediaUrls ?? (p.mediaUrl ? [p.mediaUrl] : undefined),
    }));
    runtime.log(
      JSON.stringify(
        {
          payloads: normalizedPayloads,
          meta: result.meta,
        },
        null,
        2,
      ),
    );
    // If JSON output was requested, suppress additional human-readable logs unless we're
    // also delivering, in which case we still proceed to send below.
    if (!deliver) return;
  }

  if (payloads.length === 0) {
    runtime.log("No reply from agent.");
    return;
  }

  for (const payload of payloads) {
    const mediaList =
      payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
    if (!opts.json) {
      const lines: string[] = [];
      if (payload.text) lines.push(payload.text.trimEnd());
      for (const url of mediaList) {
        lines.push(`MEDIA:${url}`);
      }
      runtime.log(lines.join("\n"));
    }

    if (!deliver) continue;

    const text = payload.text ?? "";
    const media = mediaList;
    if (!text && media.length === 0) continue;

    if (provider === "whatsapp" && whatsappTarget) {
      try {
        const primaryMedia = media[0];
        await deps.sendMessageWhatsApp(whatsappTarget, text, {
          verbose: false,
          mediaUrl: primaryMedia,
        });

        for (const extra of media.slice(1)) {
          await deps.sendMessageWhatsApp(whatsappTarget, "", {
            verbose: false,
            mediaUrl: extra,
          });
        }
      } catch (err) {
        if (!bestEffortDeliver) throw err;
        logDeliveryError(err);
      }
      continue;
    }

    if (provider === "telegram" && telegramTarget) {
      try {
        if (media.length === 0) {
          for (const chunk of chunkText(text, 4000)) {
            await deps.sendMessageTelegram(telegramTarget, chunk, {
              verbose: false,
            });
          }
        } else {
          let first = true;
          for (const url of media) {
            const caption = first ? text : "";
            first = false;
            await deps.sendMessageTelegram(telegramTarget, caption, {
              verbose: false,
              mediaUrl: url,
            });
          }
        }
      } catch (err) {
        if (!bestEffortDeliver) throw err;
        logDeliveryError(err);
      }
    }
  }
}
