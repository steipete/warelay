import fs from "node:fs/promises";
import path from "node:path";

import type { WarelayConfig } from "../config/config.js";
import { isVerbose, logVerbose } from "../globals.js";
import { logError } from "../logger.js";
import { splitMediaFromOutput } from "../media/parse.js";
import { enqueueCommand } from "../process/command-queue.js";
import { runCommandWithTimeout } from "../process/exec.js";
import {
  CLAUDE_BIN,
  CLAUDE_IDENTITY_PREFIX,
  type ClaudeJsonParseResult,
  parseClaudeJson,
} from "./claude.js";
import { applyTemplate, type TemplateContext } from "./templating.js";
import type { ReplyPayload } from "./types.js";

type CommandReplyConfig = NonNullable<WarelayConfig["inbound"]>["reply"] & {
  mode: "command";
};

type EnqueueRunner = typeof enqueueCommand;

type CommandReplyParams = {
  reply: CommandReplyConfig;
  templatingCtx: TemplateContext;
  sendSystemOnce: boolean;
  isNewSession: boolean;
  isFirstTurnInSession: boolean;
  systemSent: boolean;
  timeoutMs: number;
  timeoutSeconds: number;
  commandRunner: typeof runCommandWithTimeout;
  enqueue?: EnqueueRunner;
};

export type CommandReplyMeta = {
  durationMs: number;
  queuedMs?: number;
  queuedAhead?: number;
  exitCode?: number | null;
  signal?: string | null;
  killed?: boolean;
  claudeMeta?: string;
};

export type CommandReplyResult = {
  payload?: ReplyPayload;
  meta: CommandReplyMeta;
};

export function summarizeClaudeMetadata(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const obj = payload as Record<string, unknown>;
  const parts: string[] = [];

  if (typeof obj.duration_ms === "number") {
    parts.push(`duration=${obj.duration_ms}ms`);
  }
  if (typeof obj.duration_api_ms === "number") {
    parts.push(`api=${obj.duration_api_ms}ms`);
  }
  if (typeof obj.num_turns === "number") {
    parts.push(`turns=${obj.num_turns}`);
  }
  if (typeof obj.total_cost_usd === "number") {
    parts.push(`cost=$${obj.total_cost_usd.toFixed(4)}`);
  }

  const usage = obj.usage;
  if (usage && typeof usage === "object") {
    const serverToolUse = (
      usage as { server_tool_use?: Record<string, unknown> }
    ).server_tool_use;
    if (serverToolUse && typeof serverToolUse === "object") {
      const toolCalls = Object.values(serverToolUse).reduce<number>(
        (sum, val) => {
          if (typeof val === "number") return sum + val;
          return sum;
        },
        0,
      );
      if (toolCalls > 0) parts.push(`tool_calls=${toolCalls}`);
    }
  }

  const modelUsage = obj.modelUsage;
  if (modelUsage && typeof modelUsage === "object") {
    const models = Object.keys(modelUsage as Record<string, unknown>);
    if (models.length) {
      const display =
        models.length > 2
          ? `${models.slice(0, 2).join(",")}+${models.length - 2}`
          : models.join(",");
      parts.push(`models=${display}`);
    }
  }

  return parts.length ? parts.join(", ") : undefined;
}

export async function runCommandReply(
  params: CommandReplyParams,
): Promise<CommandReplyResult> {
  const {
    reply,
    templatingCtx,
    sendSystemOnce,
    isNewSession,
    isFirstTurnInSession,
    systemSent,
    timeoutMs,
    timeoutSeconds,
    commandRunner,
    enqueue = enqueueCommand,
  } = params;

  let argv = reply.command.map((part) => applyTemplate(part, templatingCtx));
  const templatePrefix =
    reply.template && (!sendSystemOnce || isFirstTurnInSession || !systemSent)
      ? applyTemplate(reply.template, templatingCtx)
      : "";
  if (templatePrefix && argv.length > 0) {
    argv = [argv[0], templatePrefix, ...argv.slice(1)];
  }

  // Ensure Claude commands can emit plain text by forcing --output-format when configured.
  if (
    reply.claudeOutputFormat &&
    argv.length > 0 &&
    path.basename(argv[0]) === CLAUDE_BIN
  ) {
    const hasOutputFormat = argv.some(
      (part) => part === "--output-format" || part.startsWith("--output-format="),
    );
    const insertBeforeBody = Math.max(argv.length - 1, 0);
    if (!hasOutputFormat) {
      argv = [
        ...argv.slice(0, insertBeforeBody),
        "--output-format",
        reply.claudeOutputFormat,
        ...argv.slice(insertBeforeBody),
      ];
    }
    const hasPrintFlag = argv.some(
      (part) => part === "-p" || part === "--print",
    );
    if (!hasPrintFlag) {
      const insertIdx = Math.max(argv.length - 1, 0);
      argv = [...argv.slice(0, insertIdx), "-p", ...argv.slice(insertIdx)];
    }
  }

  // Inject session args if configured (use resume for existing, session-id for new)
  if (reply.session) {
    const sessionArgList = (
      isNewSession
        ? (reply.session.sessionArgNew ?? ["--session-id", "{{SessionId}}"])
        : (reply.session.sessionArgResume ?? ["--resume", "{{SessionId}}"])
    ).map((part) => applyTemplate(part, templatingCtx));
    if (sessionArgList.length) {
      const insertBeforeBody = reply.session.sessionArgBeforeBody ?? true;
      const insertAt =
        insertBeforeBody && argv.length > 1 ? argv.length - 1 : argv.length;
      argv = [
        ...argv.slice(0, insertAt),
        ...sessionArgList,
        ...argv.slice(insertAt),
      ];
    }
  }

  let finalArgv = argv;
  const isClaudeInvocation =
    finalArgv.length > 0 && path.basename(finalArgv[0]) === CLAUDE_BIN;
  if (isClaudeInvocation && finalArgv.length > 0) {
    const bodyIdx = finalArgv.length - 1;
    const existingBody = finalArgv[bodyIdx] ?? "";
    finalArgv = [
      ...finalArgv.slice(0, bodyIdx),
      [CLAUDE_IDENTITY_PREFIX, existingBody].filter(Boolean).join("\n\n"),
    ];
  }
  logVerbose(
    `Running command auto-reply: ${finalArgv.join(" ")}${reply.cwd ? ` (cwd: ${reply.cwd})` : ""}`,
  );

  const started = Date.now();
  let queuedMs: number | undefined;
  let queuedAhead: number | undefined;
  try {
    const { stdout, stderr, code, signal, killed } = await enqueue(
      () => commandRunner(finalArgv, { timeoutMs, cwd: reply.cwd }),
      {
        onWait: (waitMs, ahead) => {
          queuedMs = waitMs;
          queuedAhead = ahead;
          if (isVerbose()) {
            logVerbose(
              `Command auto-reply queued for ${waitMs}ms (${queuedAhead} ahead)`,
            );
          }
        },
      },
    );
    const rawStdout = stdout.trim();
    let mediaFromCommand: string[] | undefined;
    let trimmed = rawStdout;
    if (stderr?.trim()) {
      logVerbose(`Command auto-reply stderr: ${stderr.trim()}`);
    }
    let parsed: ClaudeJsonParseResult | undefined;
    if (trimmed && (reply.claudeOutputFormat === "json" || isClaudeInvocation)) {
      parsed = parseClaudeJson(trimmed);
      if (parsed?.parsed && isVerbose()) {
        const summary = summarizeClaudeMetadata(parsed.parsed);
        if (summary) logVerbose(`Claude JSON meta: ${summary}`);
        logVerbose(`Claude JSON raw: ${JSON.stringify(parsed.parsed, null, 2)}`);
      }
      if (parsed?.text) {
        logVerbose(
          `Claude JSON parsed -> ${parsed.text.slice(0, 120)}${parsed.text.length > 120 ? "…" : ""}`,
        );
        trimmed = parsed.text.trim();
      } else {
        logVerbose("Claude JSON parse failed; returning raw stdout");
      }
    }
    const { text: cleanedText, mediaUrls: mediaFound } =
      splitMediaFromOutput(trimmed);
    trimmed = cleanedText;
    if (mediaFound?.length) {
      mediaFromCommand = mediaFound;
      if (isVerbose()) logVerbose(`MEDIA token extracted: ${mediaFound}`);
    } else if (isVerbose()) {
      logVerbose("No MEDIA token extracted from final text");
    }
    if (!trimmed && !mediaFromCommand) {
      const meta = parsed ? summarizeClaudeMetadata(parsed.parsed) : undefined;
      trimmed = `(command produced no output${meta ? `; ${meta}` : ""})`;
      logVerbose("No text/media produced; injecting fallback notice to user");
    }
    logVerbose(`Command auto-reply stdout (trimmed): ${trimmed || "<empty>"}`);
    logVerbose(`Command auto-reply finished in ${Date.now() - started}ms`);
    if ((code ?? 0) !== 0) {
      console.error(
        `Command auto-reply exited with code ${code ?? "unknown"} (signal: ${signal ?? "none"})`,
      );
      return {
        payload: undefined,
        meta: {
          durationMs: Date.now() - started,
          queuedMs,
          queuedAhead,
          exitCode: code,
          signal,
          killed,
          claudeMeta: parsed ? summarizeClaudeMetadata(parsed.parsed) : undefined,
        },
      };
    }
    if (killed && !signal) {
      console.error(
        `Command auto-reply process killed before completion (exit code ${code ?? "unknown"})`,
      );
      return {
        payload: undefined,
        meta: {
          durationMs: Date.now() - started,
          queuedMs,
          queuedAhead,
          exitCode: code,
          signal,
          killed,
          claudeMeta: parsed ? summarizeClaudeMetadata(parsed.parsed) : undefined,
        },
      };
    }
    let mediaUrls =
      mediaFromCommand ?? (reply.mediaUrl ? [reply.mediaUrl] : undefined);

    // If mediaMaxMb is set, skip local media paths larger than the cap.
    if (mediaUrls?.length && reply.mediaMaxMb) {
      const maxBytes = reply.mediaMaxMb * 1024 * 1024;
      const filtered: string[] = [];
      for (const url of mediaUrls) {
        if (/^https?:\/\//i.test(url)) {
          filtered.push(url);
          continue;
        }
        const abs = path.isAbsolute(url) ? url : path.resolve(url);
        try {
          const stats = await fs.stat(abs);
          if (stats.size <= maxBytes) {
            filtered.push(url);
          } else if (isVerbose()) {
            logVerbose(
              `Skipping media ${url} (${(stats.size / (1024 * 1024)).toFixed(2)}MB) over cap ${reply.mediaMaxMb}MB`,
            );
          }
        } catch {
          filtered.push(url);
        }
      }
      mediaUrls = filtered;
    }

    const payload =
      trimmed || mediaUrls?.length
        ? {
            text: trimmed || undefined,
            mediaUrl: mediaUrls?.[0],
            mediaUrls,
          }
        : undefined;
    const meta: CommandReplyMeta = {
      durationMs: Date.now() - started,
      queuedMs,
      queuedAhead,
      exitCode: code,
      signal,
      killed,
      claudeMeta: parsed ? summarizeClaudeMetadata(parsed.parsed) : undefined,
    };
    if (isVerbose()) {
      logVerbose(`Command auto-reply meta: ${JSON.stringify(meta)}`);
    }
    return { payload, meta };
  } catch (err) {
    const elapsed = Date.now() - started;
    const anyErr = err as { killed?: boolean; signal?: string };
    const timeoutHit = anyErr.killed === true || anyErr.signal === "SIGKILL";
    const errorObj = err as { stdout?: string; stderr?: string };
    if (errorObj.stderr?.trim()) {
      logVerbose(`Command auto-reply stderr: ${errorObj.stderr.trim()}`);
    }
    if (timeoutHit) {
      console.error(
        `Command auto-reply timed out after ${elapsed}ms (limit ${timeoutMs}ms)`,
      );
      const baseMsg =
        "Command timed out after " +
        `${timeoutSeconds}s. Try a shorter prompt or split the request.`;
      const partial = errorObj.stdout?.trim();
      const partialSnippet =
        partial && partial.length > 800 ? `${partial.slice(0, 800)}...` : partial;
      const text = partialSnippet
        ? `${baseMsg}\n\nPartial output before timeout:\n${partialSnippet}`
        : baseMsg;
      return {
        payload: { text },
        meta: {
          durationMs: elapsed,
          queuedMs,
          queuedAhead,
          exitCode: undefined,
          signal: anyErr.signal,
          killed: anyErr.killed,
        },
      };
    }
    logError(`Command auto-reply failed after ${elapsed}ms: ${String(err)}`);
    return {
      payload: undefined,
      meta: {
        durationMs: elapsed,
        queuedMs,
        queuedAhead,
        exitCode: undefined,
        signal: anyErr.signal,
        killed: anyErr.killed,
      },
    };
  }
}
