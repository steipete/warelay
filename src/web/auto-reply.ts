import { getReplyFromConfig } from "../auto-reply/reply.js";
import { waitForever } from "../cli/wait.js";
import { loadConfig } from "../config/config.js";
import { danger, isVerbose, logVerbose, success } from "../globals.js";
import { logInfo } from "../logger.js";
import { getChildLogger } from "../logging.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { monitorWebInbox } from "./inbound.js";
import { loadWebMedia } from "./media.js";
import {
  computeBackoff,
  newConnectionId,
  type ReconnectPolicy,
  resolveHeartbeatSeconds,
  resolveReconnectPolicy,
  sleepWithAbort,
} from "./reconnect.js";
import { getWebAuthAgeMs } from "./session.js";

const DEFAULT_WEB_MEDIA_BYTES = 5 * 1024 * 1024;

export type WebMonitorTuning = {
  reconnect?: Partial<ReconnectPolicy>;
  heartbeatSeconds?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

const formatDuration = (ms: number) =>
  ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`;

export async function monitorWebProvider(
  verbose: boolean,
  listenerFactory: typeof monitorWebInbox | undefined = monitorWebInbox,
  keepAlive = true,
  replyResolver: typeof getReplyFromConfig | undefined = getReplyFromConfig,
  runtime: RuntimeEnv = defaultRuntime,
  abortSignal?: AbortSignal,
  tuning: WebMonitorTuning = {},
) {
  const runId = newConnectionId();
  const replyLogger = getChildLogger({ module: "web-auto-reply", runId });
  const heartbeatLogger = getChildLogger({ module: "web-heartbeat", runId });
  const reconnectLogger = getChildLogger({ module: "web-reconnect", runId });
  const cfg = loadConfig();
  const configuredMaxMb = cfg.inbound?.reply?.mediaMaxMb;
  const maxMediaBytes =
    typeof configuredMaxMb === "number" && configuredMaxMb > 0
      ? configuredMaxMb * 1024 * 1024
      : DEFAULT_WEB_MEDIA_BYTES;
  const heartbeatSeconds = resolveHeartbeatSeconds(
    cfg,
    tuning.heartbeatSeconds,
  );
  const reconnectPolicy = resolveReconnectPolicy(cfg, tuning.reconnect);
  const sleep =
    tuning.sleep ??
    ((ms: number, signal?: AbortSignal) =>
      sleepWithAbort(ms, signal ?? abortSignal));
  const stopRequested = () => abortSignal?.aborted === true;
  const abortPromise =
    abortSignal &&
    new Promise<"aborted">((resolve) =>
      abortSignal.addEventListener("abort", () => resolve("aborted"), {
        once: true,
      }),
    );

  let sigintStop = false;
  const handleSigint = () => {
    sigintStop = true;
  };
  process.once("SIGINT", handleSigint);

  let reconnectAttempts = 0;

  while (true) {
    if (stopRequested()) break;

    const connectionId = newConnectionId();
    const startedAt = Date.now();
    let heartbeat: NodeJS.Timeout | null = null;
    let lastMessageAt: number | null = null;
    let handledMessages = 0;

    const listener = await (listenerFactory ?? monitorWebInbox)({
      verbose,
      onMessage: async (msg) => {
        handledMessages += 1;
        lastMessageAt = Date.now();
        const ts = msg.timestamp
          ? new Date(msg.timestamp).toISOString()
          : new Date().toISOString();
        const correlationId = msg.id ?? newConnectionId();
        replyLogger.info(
          {
            connectionId,
            correlationId,
            from: msg.from,
            to: msg.to,
            body: msg.body,
            mediaType: msg.mediaType ?? null,
            mediaPath: msg.mediaPath ?? null,
          },
          "inbound web message",
        );

        console.log(`\n[${ts}] ${msg.from} -> ${msg.to}: ${msg.body}`);

        const replyStarted = Date.now();
        const replyResult = await (replyResolver ?? getReplyFromConfig)(
          {
            Body: msg.body,
            From: msg.from,
            To: msg.to,
            MessageSid: msg.id,
            MediaPath: msg.mediaPath,
            MediaUrl: msg.mediaUrl,
            MediaType: msg.mediaType,
          },
          {
            onReplyStart: msg.sendComposing,
          },
        );
        if (
          !replyResult ||
          (!replyResult.text &&
            !replyResult.mediaUrl &&
            !replyResult.mediaUrls?.length)
        ) {
          logVerbose(
            "Skipping auto-reply: no text/media returned from resolver",
          );
          return;
        }
        try {
          const mediaList = replyResult.mediaUrls?.length
            ? replyResult.mediaUrls
            : replyResult.mediaUrl
              ? [replyResult.mediaUrl]
              : [];

          if (mediaList.length > 0) {
            logVerbose(
              `Web auto-reply media detected: ${mediaList.filter(Boolean).join(", ")}`,
            );
            for (const [index, mediaUrl] of mediaList.entries()) {
              try {
                const media = await loadWebMedia(mediaUrl, maxMediaBytes);
                if (isVerbose()) {
                  logVerbose(
                    `Web auto-reply media size: ${(media.buffer.length / (1024 * 1024)).toFixed(2)}MB`,
                  );
                  logVerbose(
                    `Web auto-reply media source: ${mediaUrl} (kind ${media.kind})`,
                  );
                }
                const caption =
                  index === 0 ? replyResult.text || undefined : undefined;
                if (media.kind === "image") {
                  await msg.sendMedia({
                    image: media.buffer,
                    caption,
                    mimetype: media.contentType,
                  });
                } else if (media.kind === "audio") {
                  await msg.sendMedia({
                    audio: media.buffer,
                    ptt: true,
                    mimetype: media.contentType,
                    caption,
                  });
                } else if (media.kind === "video") {
                  await msg.sendMedia({
                    video: media.buffer,
                    caption,
                    mimetype: media.contentType,
                  });
                } else {
                  const fileName = mediaUrl.split("/").pop() ?? "file";
                  const mimetype =
                    media.contentType ?? "application/octet-stream";
                  await msg.sendMedia({
                    document: media.buffer,
                    fileName,
                    caption,
                    mimetype,
                  });
                }
                logInfo(
                  `✅ Sent web media reply to ${msg.from} (${(media.buffer.length / (1024 * 1024)).toFixed(2)}MB)`,
                  runtime,
                );
                replyLogger.info(
                  {
                    connectionId,
                    correlationId,
                    to: msg.from,
                    from: msg.to,
                    text: index === 0 ? (replyResult.text ?? null) : null,
                    mediaUrl,
                    mediaSizeBytes: media.buffer.length,
                    mediaKind: media.kind,
                    durationMs: Date.now() - replyStarted,
                  },
                  "auto-reply sent (media)",
                );
              } catch (err) {
                console.error(
                  danger(
                    `Failed sending web media to ${msg.from}: ${String(err)}`,
                  ),
                );
                if (index === 0 && replyResult.text) {
                  console.log(
                    `⚠️  Media skipped; sent text-only to ${msg.from}`,
                  );
                  await msg.reply(replyResult.text || "");
                }
              }
            }
          } else if (replyResult.text) {
            await msg.reply(replyResult.text);
          }

          const durationMs = Date.now() - replyStarted;
          const hasMedia = mediaList.length > 0;
          if (isVerbose()) {
            console.log(
              success(
                `↩️  Auto-replied to ${msg.from} (web, ${replyResult.text?.length ?? 0} chars${hasMedia ? ", media" : ""}, ${formatDuration(durationMs)})`,
              ),
            );
          } else {
            console.log(
              success(
                `↩️  ${replyResult.text ?? "<media>"}${hasMedia ? " (media)" : ""}`,
              ),
            );
          }
          replyLogger.info(
            {
              connectionId,
              correlationId,
              to: msg.from,
              from: msg.to,
              text: replyResult.text ?? null,
              mediaUrl: mediaList[0] ?? null,
              durationMs,
            },
            "auto-reply sent",
          );
        } catch (err) {
          console.error(
            danger(
              `Failed sending web auto-reply to ${msg.from}: ${String(err)}`,
            ),
          );
        }
      },
    });

    const closeListener = async () => {
      if (heartbeat) clearInterval(heartbeat);
      try {
        await listener.close();
      } catch (err) {
        logVerbose(`Socket close failed: ${String(err)}`);
      }
    };

    if (keepAlive) {
      heartbeat = setInterval(() => {
        const authAgeMs = getWebAuthAgeMs();
        heartbeatLogger.info(
          {
            connectionId,
            reconnectAttempts,
            messagesHandled: handledMessages,
            lastMessageAt,
            authAgeMs,
            uptimeMs: Date.now() - startedAt,
          },
          "web relay heartbeat",
        );
      }, heartbeatSeconds * 1000);
    }

    logInfo(
      "📡 Listening for personal WhatsApp Web inbound messages. Leave this running; Ctrl+C to stop.",
      runtime,
    );

    if (!keepAlive) {
      await closeListener();
      return;
    }

    const reason = await Promise.race([
      listener.onClose ?? waitForever(),
      abortPromise ?? waitForever(),
    ]);

    const uptimeMs = Date.now() - startedAt;
    if (uptimeMs > heartbeatSeconds * 1000) {
      reconnectAttempts = 0; // Healthy stretch; reset the backoff.
    }

    if (stopRequested() || sigintStop || reason === "aborted") {
      await closeListener();
      break;
    }

    const status =
      (typeof reason === "object" && reason && "status" in reason
        ? (reason as { status?: number }).status
        : undefined) ?? "unknown";
    const loggedOut =
      typeof reason === "object" &&
      reason &&
      "isLoggedOut" in reason &&
      (reason as { isLoggedOut?: boolean }).isLoggedOut;

    reconnectLogger.info(
      {
        connectionId,
        status,
        loggedOut,
        reconnectAttempts,
      },
      "web reconnect: connection closed",
    );

    if (loggedOut) {
      runtime.error(
        danger(
          "WhatsApp session logged out. Run `warelay login --provider web` to relink.",
        ),
      );
      await closeListener();
      break;
    }

    reconnectAttempts += 1;
    if (
      reconnectPolicy.maxAttempts > 0 &&
      reconnectAttempts >= reconnectPolicy.maxAttempts
    ) {
      reconnectLogger.warn(
        {
          connectionId,
          status,
          reconnectAttempts,
          maxAttempts: reconnectPolicy.maxAttempts,
        },
        "web reconnect: max attempts reached",
      );
      runtime.error(
        danger(
          `WhatsApp Web connection closed (status ${status}). Reached max retries (${reconnectPolicy.maxAttempts}); exiting so you can relink.`,
        ),
      );
      await closeListener();
      break;
    }

    const delay = computeBackoff(reconnectPolicy, reconnectAttempts);
    reconnectLogger.info(
      {
        connectionId,
        status,
        reconnectAttempts,
        maxAttempts: reconnectPolicy.maxAttempts || "unlimited",
        delayMs: delay,
      },
      "web reconnect: scheduling retry",
    );
    runtime.error(
      danger(
        `WhatsApp Web connection closed (status ${status}). Retry ${reconnectAttempts}/${reconnectPolicy.maxAttempts || "∞"} in ${formatDuration(delay)}…`,
      ),
    );
    await closeListener();
    try {
      await sleep(delay, abortSignal);
    } catch {
      break;
    }
  }

  process.removeListener("SIGINT", handleSigint);
}

export { DEFAULT_WEB_MEDIA_BYTES };
