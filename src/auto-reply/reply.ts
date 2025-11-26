import crypto from "node:crypto";

import type { MessageInstance } from "twilio/lib/rest/api/v2010/account/message.js";
import { loadConfig, type WarelayConfig } from "../config/config.js";
import {
  DEFAULT_IDLE_MINUTES,
  DEFAULT_RESET_TRIGGER,
  deriveSessionKey,
  loadSessionStore,
  resolveStorePath,
  saveSessionStore,
} from "../config/sessions.js";
import { info, isVerbose, logVerbose } from "../globals.js";
import { ensureMediaHosted } from "../media/host.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import type { TwilioRequester } from "../twilio/types.js";
import { sendTypingIndicator } from "../twilio/typing.js";
import { runCommandReply } from "./command-reply.js";
import { transcribeInboundAudio, isAudio } from "./transcription.js";
import {
  applyTemplate,
  type MsgContext,
  type TemplateContext,
} from "./templating.js";
import type { GetReplyOptions, ReplyPayload } from "./types.js";
export type { ReplyPayload, GetReplyOptions } from "./types.js";

export async function getReplyFromConfig(
  ctx: MsgContext,
  opts?: GetReplyOptions,
  configOverride?: WarelayConfig,
  commandRunner: typeof runCommandWithTimeout = runCommandWithTimeout,
): Promise<ReplyPayload | undefined> {
  // Choose reply from config: static text or external command stdout.
  const cfg = configOverride ?? loadConfig();
  const reply = cfg.inbound?.reply;
  const timeoutSeconds = Math.max(reply?.timeoutSeconds ?? 600, 1);
  const timeoutMs = timeoutSeconds * 1000;
  let started = false;
  const triggerTyping = async () => {
    await opts?.onReplyStart?.();
  };
  const onReplyStart = async () => {
    if (started) return;
    started = true;
    await triggerTyping();
  };
  let typingTimer: NodeJS.Timeout | undefined;
  const typingIntervalMs =
    reply?.mode === "command"
      ? (reply.typingIntervalSeconds ??
          reply?.session?.typingIntervalSeconds ??
          8) * 1000
      : 0;
  const cleanupTyping = () => {
    if (typingTimer) {
      clearInterval(typingTimer);
      typingTimer = undefined;
    }
  };
  const startTypingLoop = async () => {
    if (!opts?.onReplyStart) return;
    if (typingIntervalMs <= 0) return;
    if (typingTimer) return;
    await triggerTyping();
    typingTimer = setInterval(() => {
      void triggerTyping();
    }, typingIntervalMs);
  };
  let transcribedText: string | undefined;

  // Optional audio transcription before templating/session handling.
  if (cfg.inbound?.transcribeAudio && isAudio(ctx.MediaType)) {
    const transcribed = await transcribeInboundAudio(cfg, ctx, defaultRuntime);
    if (transcribed?.text) {
      transcribedText = transcribed.text;
      ctx.Body = transcribed.text;
      ctx.Transcript = transcribed.text;
      logVerbose("Replaced Body with audio transcript for reply flow");
    }
  }

  // Optional session handling (conversation reuse + /new resets)
  const sessionCfg = reply?.session;
  const resetTriggers = sessionCfg?.resetTriggers?.length
    ? sessionCfg.resetTriggers
    : [DEFAULT_RESET_TRIGGER];
  const idleMinutes = Math.max(
    sessionCfg?.idleMinutes ?? DEFAULT_IDLE_MINUTES,
    1,
  );
  const sessionScope = sessionCfg?.scope ?? "per-sender";
  const storePath = resolveStorePath(sessionCfg?.store);
  let sessionStore: ReturnType<typeof loadSessionStore> | undefined;
  let sessionKey: string | undefined;

  let sessionId: string | undefined;
  let isNewSession = false;
  let bodyStripped: string | undefined;
  let systemSent = false;

  if (sessionCfg) {
    const trimmedBody = (ctx.Body ?? "").trim();
    for (const trigger of resetTriggers) {
      if (!trigger) continue;
      if (trimmedBody === trigger) {
        isNewSession = true;
        bodyStripped = "";
        break;
      }
      const triggerPrefix = `${trigger} `;
      if (trimmedBody.startsWith(triggerPrefix)) {
        isNewSession = true;
        bodyStripped = trimmedBody.slice(trigger.length).trimStart();
        break;
      }
    }

    sessionKey = deriveSessionKey(sessionScope, ctx);
    sessionStore = loadSessionStore(storePath);
    const entry = sessionStore[sessionKey];
    const idleMs = idleMinutes * 60_000;
    const freshEntry = entry && Date.now() - entry.updatedAt <= idleMs;

    if (!isNewSession && freshEntry) {
      sessionId = entry.sessionId;
      systemSent = entry.systemSent ?? false;
    } else {
      sessionId = crypto.randomUUID();
      isNewSession = true;
      systemSent = false;
    }

    sessionStore[sessionKey] = { sessionId, updatedAt: Date.now(), systemSent };
    await saveSessionStore(storePath, sessionStore);
  }

  const sessionCtx: TemplateContext = {
    ...ctx,
    BodyStripped: bodyStripped ?? ctx.Body,
    SessionId: sessionId,
    IsNewSession: isNewSession ? "true" : "false",
  };

  // Optional allowlist by origin number (E.164 without whatsapp: prefix)
  const allowFrom = cfg.inbound?.allowFrom;
  if (Array.isArray(allowFrom) && allowFrom.length > 0) {
    const from = (ctx.From ?? "").replace(/^whatsapp:/, "");
    if (!allowFrom.includes(from)) {
      logVerbose(
        `Skipping auto-reply: sender ${from || "<unknown>"} not in allowFrom list`,
      );
      cleanupTyping();
      return undefined;
    }
  }

  await startTypingLoop();

  // Optional prefix injected before Body for templating/command prompts.
  const sendSystemOnce = sessionCfg?.sendSystemOnce === true;
  const isFirstTurnInSession = isNewSession || !systemSent;
  const sessionIntro =
    isFirstTurnInSession && sessionCfg?.sessionIntro
      ? applyTemplate(sessionCfg.sessionIntro, sessionCtx)
      : "";
  const bodyPrefix = reply?.bodyPrefix
    ? applyTemplate(reply.bodyPrefix, sessionCtx)
    : "";
  const baseBody = sessionCtx.BodyStripped ?? sessionCtx.Body ?? "";
  const prefixedBodyBase = (() => {
    let body = baseBody;
    if (!sendSystemOnce || isFirstTurnInSession) {
      body = bodyPrefix ? `${bodyPrefix}${body}` : body;
    }
    if (sessionIntro) {
      body = `${sessionIntro}\n\n${body}`;
    }
    return body;
  })();
  if (
    sessionCfg &&
    sendSystemOnce &&
    isFirstTurnInSession &&
    sessionStore &&
    sessionKey
  ) {
    sessionStore[sessionKey] = {
      ...(sessionStore[sessionKey] ?? {}),
      sessionId: sessionId ?? crypto.randomUUID(),
      updatedAt: Date.now(),
      systemSent: true,
    };
    await saveSessionStore(storePath, sessionStore);
    systemSent = true;
  }

  const prefixedBody =
    transcribedText && reply?.mode === "command"
      ? [prefixedBodyBase, `Transcript:\n${transcribedText}`]
          .filter(Boolean)
          .join("\n\n")
      : prefixedBodyBase;
  const mediaNote = ctx.MediaPath?.length
    ? `[media attached: ${ctx.MediaPath}${ctx.MediaType ? ` (${ctx.MediaType})` : ""}${ctx.MediaUrl ? ` | ${ctx.MediaUrl}` : ""}]`
    : undefined;
  // For command prompts we prepend the media note so Claude et al. see it; text replies stay clean.
  const mediaReplyHint =
    mediaNote && reply?.mode === "command"
      ? "To send an image back, add a line like: MEDIA:https://example.com/image.jpg (no spaces). Keep caption in the text body."
      : undefined;
  const commandBody = mediaNote
    ? [mediaNote, mediaReplyHint, prefixedBody ?? ""]
        .filter(Boolean)
        .join("\n")
        .trim()
    : prefixedBody;
  const templatingCtx: TemplateContext = {
    ...sessionCtx,
    Body: commandBody,
    BodyStripped: commandBody,
  };
  if (!reply) {
    logVerbose("No inbound.reply configured; skipping auto-reply");
    cleanupTyping();
    return undefined;
  }

  if (reply.mode === "text" && reply.text) {
    await onReplyStart();
    logVerbose("Using text auto-reply from config");
    const result = {
      text: applyTemplate(reply.text, templatingCtx),
      mediaUrl: reply.mediaUrl,
    };
    cleanupTyping();
    return result;
  }

  if (reply.mode === "command" && reply.command?.length) {
    await onReplyStart();
    try {
      const { payload, meta } = await runCommandReply({
        reply,
        templatingCtx,
        sendSystemOnce,
        isNewSession,
        isFirstTurnInSession,
        systemSent,
        timeoutMs,
        timeoutSeconds,
        commandRunner,
      });
      if (meta.claudeMeta && isVerbose()) {
        logVerbose(`Claude JSON meta: ${meta.claudeMeta}`);
      }
      return payload;
    } finally {
      cleanupTyping();
    }
  }

  cleanupTyping();
  return undefined;
}

type TwilioLikeClient = TwilioRequester & {
  messages: {
    create: (opts: {
      from?: string;
      to?: string;
      body: string;
    }) => Promise<unknown>;
  };
};

export async function autoReplyIfConfigured(
  client: TwilioLikeClient,
  message: MessageInstance,
  configOverride?: WarelayConfig,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  // Fire a config-driven reply (text or command) for the inbound message, if configured.
  const ctx: MsgContext = {
    Body: message.body ?? undefined,
    From: message.from ?? undefined,
    To: message.to ?? undefined,
    MessageSid: message.sid,
  };
  const cfg = configOverride ?? loadConfig();
  // Attach media hints for transcription/templates if present on Twilio payloads.
  const mediaUrl = (message as { mediaUrl?: string }).mediaUrl;
  if (mediaUrl) ctx.MediaUrl = mediaUrl;

  // Optional audio transcription before building reply.
  const mediaField = (message as { media?: unknown }).media;
  const mediaItems = Array.isArray(mediaField) ? mediaField : [];
  if (cfg.inbound?.transcribeAudio && mediaItems.length) {
    const media = mediaItems[0];
    const contentType = (media as { contentType?: string }).contentType;
    if (contentType?.startsWith("audio")) {
      const transcribed = await transcribeInboundAudio(cfg, ctx, runtime);
      if (transcribed?.text) {
        ctx.Body = transcribed.text;
        ctx.MediaType = contentType;
        logVerbose("Replaced Body with audio transcript for reply flow");
      }
    }
  }

  const replyResult = await getReplyFromConfig(
    ctx,
    {
      onReplyStart: () => sendTypingIndicator(client, runtime, message.sid),
    },
    cfg,
  );
  if (
    !replyResult ||
    (!replyResult.text &&
      !replyResult.mediaUrl &&
      !replyResult.mediaUrls?.length)
  )
    return;

  const replyFrom = message.to;
  const replyTo = message.from;
  if (!replyFrom || !replyTo) {
    if (isVerbose())
      console.error(
        "Skipping auto-reply: missing to/from on inbound message",
        ctx,
      );
    return;
  }

  if (replyResult.text) {
    logVerbose(
      `Auto-replying via Twilio: from ${replyFrom} to ${replyTo}, body length ${replyResult.text.length}`,
    );
  } else {
    logVerbose(
      `Auto-replying via Twilio: from ${replyFrom} to ${replyTo} (media)`,
    );
  }

  try {
    const mediaList = replyResult.mediaUrls?.length
      ? replyResult.mediaUrls
      : replyResult.mediaUrl
        ? [replyResult.mediaUrl]
        : [];

    const sendTwilio = async (body: string, media?: string) => {
      let resolvedMedia = media;
      if (resolvedMedia && !/^https?:\/\//i.test(resolvedMedia)) {
        const hosted = await ensureMediaHosted(resolvedMedia);
        resolvedMedia = hosted.url;
      }
      await client.messages.create({
        from: replyFrom,
        to: replyTo,
        body,
        ...(resolvedMedia ? { mediaUrl: [resolvedMedia] } : {}),
      });
    };

    if (mediaList.length === 0) {
      await sendTwilio(replyResult.text ?? "");
    } else {
      // First media with body (if any), then remaining as separate media-only sends.
      await sendTwilio(replyResult.text ?? "", mediaList[0]);
      for (const extra of mediaList.slice(1)) {
        await sendTwilio("", extra);
      }
    }
    if (isVerbose()) {
      console.log(
        info(
          `↩️  Auto-replied to ${replyTo} (sid ${message.sid ?? "no-sid"}${replyResult.mediaUrl ? ", media" : ""})`,
        ),
      );
    }
  } catch (err) {
    const anyErr = err as {
      code?: string | number;
      message?: unknown;
      moreInfo?: unknown;
      status?: string | number;
      response?: { body?: unknown };
    };
    const { code, status } = anyErr;
    const msg =
      typeof anyErr?.message === "string"
        ? anyErr.message
        : (anyErr?.message ?? err);
    runtime.error(
      `❌ Twilio send failed${code ? ` (code ${code})` : ""}${status ? ` status ${status}` : ""}: ${msg}`,
    );
    if (anyErr?.moreInfo) runtime.error(`More info: ${anyErr.moreInfo}`);
    const responseBody = anyErr?.response?.body;
    if (responseBody) {
      runtime.error("Response body:");
      runtime.error(JSON.stringify(responseBody, null, 2));
    }
  }
}
