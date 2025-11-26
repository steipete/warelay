import { getReplyFromConfig } from "../auto-reply/reply.js";
import { waitForever } from "../cli/wait.js";
import { loadConfig } from "../config/config.js";
import { danger, isVerbose, logVerbose, success } from "../globals.js";
import { logInfo } from "../logger.js";
import { getChildLogger } from "../logging.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { monitorWebInbox } from "./inbound.js";
import { loadWebMedia } from "./media.js";

const DEFAULT_WEB_MEDIA_BYTES = 5 * 1024 * 1024;

const formatDuration = (ms: number) =>
  ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`;

export async function monitorWebProvider(
  verbose: boolean,
  listenerFactory = monitorWebInbox,
  keepAlive = true,
  replyResolver: typeof getReplyFromConfig = getReplyFromConfig,
  runtime: RuntimeEnv = defaultRuntime,
  abortSignal?: AbortSignal,
) {
  const replyLogger = getChildLogger({ module: "web-auto-reply" });
  const cfg = loadConfig();
  const configuredMaxMb = cfg.inbound?.reply?.mediaMaxMb;
  const maxMediaBytes =
    typeof configuredMaxMb === "number" && configuredMaxMb > 0
      ? configuredMaxMb * 1024 * 1024
      : DEFAULT_WEB_MEDIA_BYTES;
  const stopRequested = () => abortSignal?.aborted === true;
  const abortPromise =
    abortSignal &&
    new Promise<"aborted">((resolve) =>
      abortSignal.addEventListener("abort", () => resolve("aborted"), {
        once: true,
      }),
    );

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

  while (true) {
    if (stopRequested()) break;

    const listener = await listenerFactory({
      verbose,
      onMessage: async (msg) => {
        const ts = msg.timestamp
          ? new Date(msg.timestamp).toISOString()
          : new Date().toISOString();
        console.log(`\n[${ts}] ${msg.from} -> ${msg.to}: ${msg.body}`);

        const replyStarted = Date.now();
        const replyResult = await replyResolver(
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

    logInfo(
      "📡 Listening for personal WhatsApp Web inbound messages. Leave this running; Ctrl+C to stop.",
      runtime,
    );
    let stop = false;
    process.on("SIGINT", () => {
      stop = true;
      void listener.close().finally(() => {
        logInfo("👋 Web monitor stopped", runtime);
        runtime.exit(0);
      });
    });

    if (!keepAlive) return;

    const reason = await Promise.race([
      listener.onClose ?? waitForever(),
      abortPromise ?? waitForever(),
    ]);

    if (stopRequested() || stop || reason === "aborted") {
      await listener.close();
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

    if (loggedOut) {
      runtime.error(
        danger(
          "WhatsApp session logged out. Run `warelay login --provider web` to relink.",
        ),
      );
      break;
    }

    runtime.error(
      danger(
        `WhatsApp Web connection closed (status ${status}). Reconnecting in 2s…`,
      ),
    );
    await listener.close();
    await sleep(2_000);
  }
}

export { DEFAULT_WEB_MEDIA_BYTES };
