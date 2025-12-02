import fs from "node:fs/promises";
import path from "node:path";

import { type AgentKind, getAgentSpec } from "../agents/index.js";
import type { AgentMeta } from "../agents/types.js";
import type { WarelayConfig } from "../config/config.js";
import { isVerbose, logVerbose } from "../globals.js";
import { logError } from "../logger.js";
import { getChildLogger } from "../logging.js";
import { splitMediaFromOutput } from "../media/parse.js";
import { enqueueCommand } from "../process/command-queue.js";
import type { runCommandWithTimeout } from "../process/exec.js";
import { runPiRpc } from "../process/tau-rpc.js";
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
  agentMeta?: AgentMeta;
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
  const logger = getChildLogger({ module: "command-reply" });
  const verboseLog = (msg: string) => {
    logger.debug(msg);
    if (isVerbose()) logVerbose(msg);
  };

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

  if (!reply.command?.length) {
    throw new Error("reply.command is required for mode=command");
  }
  const agentCfg = reply.agent ?? { kind: "claude" };
  const agentKind: AgentKind = agentCfg.kind ?? "claude";
  const agent = getAgentSpec(agentKind);

  let argv = reply.command.map((part) => applyTemplate(part, templatingCtx));
  const templatePrefix =
    reply.template && (!sendSystemOnce || isFirstTurnInSession || !systemSent)
      ? applyTemplate(reply.template, templatingCtx)
      : "";
  if (templatePrefix && argv.length > 0) {
    argv = [argv[0], templatePrefix, ...argv.slice(1)];
  }

  // Default body index is last arg
  let bodyIndex = Math.max(argv.length - 1, 0);

  // Session args prepared (templated) and injected generically
  if (reply.session) {
    const defaultSessionArgs = (() => {
      switch (agentCfg.kind) {
        case "claude":
          return {
            newArgs: ["--session-id", "{{SessionId}}"],
            resumeArgs: ["--resume", "{{SessionId}}"],
          };
        case "gemini":
          // Gemini CLI supports --resume <id>; starting a new session needs no flag.
          return { newArgs: [], resumeArgs: ["--resume", "{{SessionId}}"] };
        default:
          return {
            newArgs: ["--session", "{{SessionId}}"],
            resumeArgs: ["--session", "{{SessionId}}"],
          };
      }
    })();
    const defaultNew = defaultSessionArgs.newArgs;
    const defaultResume = defaultSessionArgs.resumeArgs;
    const sessionArgList = (
      isNewSession
        ? (reply.session.sessionArgNew ?? defaultNew)
        : (reply.session.sessionArgResume ?? defaultResume)
    ).map((p) => applyTemplate(p, templatingCtx));
    if (sessionArgList.length) {
      const insertBeforeBody = reply.session.sessionArgBeforeBody ?? true;
      const insertAt =
        insertBeforeBody && argv.length > 1 ? argv.length - 1 : argv.length;
      argv = [
        ...argv.slice(0, insertAt),
        ...sessionArgList,
        ...argv.slice(insertAt),
      ];
      bodyIndex = Math.max(argv.length - 1, 0);
    }
  }

  const shouldApplyAgent = agent.isInvocation(argv);
  const finalArgv = shouldApplyAgent
    ? agent.buildArgs({
        argv,
        bodyIndex,
        isNewSession,
        sessionId: templatingCtx.SessionId,
        sendSystemOnce,
        systemSent,
        identityPrefix: agentCfg.identityPrefix,
        format: agentCfg.format,
      })
    : argv;

  logVerbose(
    `Running command auto-reply: ${finalArgv.join(" ")}${reply.cwd ? ` (cwd: ${reply.cwd})` : ""}`,
  );

  const started = Date.now();
  let queuedMs: number | undefined;
  let queuedAhead: number | undefined;
  try {
    const run = async () => {
      // Prefer long-lived tau RPC for pi agent to avoid cold starts.
      if (agentKind === "pi") {
        const body = finalArgv[bodyIndex] ?? "";
        // Build rpc args without the prompt body; force --mode rpc.
        const rpcArgv = (() => {
          const copy = [...finalArgv];
          copy.splice(bodyIndex, 1);
          const modeIdx = copy.indexOf("--mode");
          if (modeIdx >= 0 && copy[modeIdx + 1]) {
            copy.splice(modeIdx, 2, "--mode", "rpc");
          } else if (!copy.includes("--mode")) {
            copy.splice(copy.length - 1, 0, "--mode", "rpc");
          }
          return copy;
        })();
        return await runPiRpc({
          argv: rpcArgv,
          cwd: reply.cwd,
          prompt: body,
          timeoutMs,
        });
      }
      return await commandRunner(finalArgv, { timeoutMs, cwd: reply.cwd });
    };

    const { stdout, stderr, code, signal, killed } = await enqueue(run, {
      onWait: (waitMs, ahead) => {
        queuedMs = waitMs;
        queuedAhead = ahead;
        if (isVerbose()) {
          logVerbose(
            `Command auto-reply queued for ${waitMs}ms (${queuedAhead} ahead)`,
          );
        }
      },
    });
    const rawStdout = stdout.trim();
    let mediaFromCommand: string[] | undefined;
    let trimmed = rawStdout;
    if (stderr?.trim()) {
      logVerbose(`Command auto-reply stderr: ${stderr.trim()}`);
    }

    const parsed = trimmed ? agent.parseOutput(trimmed) : undefined;
    // Treat empty string as "no content" so we can fall back to the friendly
    // "(command produced no output)" message instead of echoing raw JSON.
    if (parsed && parsed.text !== undefined) {
      trimmed = parsed.text.trim();
    }

    const { text: cleanedText, mediaUrls: mediaFound } =
      splitMediaFromOutput(trimmed);
    trimmed = cleanedText;
    if (mediaFound?.length) {
      mediaFromCommand = mediaFound;
      verboseLog(`MEDIA token extracted: ${mediaFound}`);
    } else {
      verboseLog("No MEDIA token extracted from final text");
    }
    if (!trimmed && !mediaFromCommand) {
      const meta = parsed?.meta?.extra?.summary ?? undefined;
      trimmed = `(command produced no output${meta ? `; ${meta}` : ""})`;
      verboseLog("No text/media produced; injecting fallback notice to user");
    }
    verboseLog(`Command auto-reply stdout (trimmed): ${trimmed || "<empty>"}`);
    const elapsed = Date.now() - started;
    verboseLog(`Command auto-reply finished in ${elapsed}ms`);
    logger.info(
      { durationMs: elapsed, agent: agentKind, cwd: reply.cwd },
      "command auto-reply finished",
    );
    if ((code ?? 0) !== 0) {
      console.error(
        `Command auto-reply exited with code ${code ?? "unknown"} (signal: ${signal ?? "none"})`,
      );
      // Include any partial output or stderr in error message
      const partialOut = trimmed
        ? `\n\nOutput: ${trimmed.slice(0, 500)}${trimmed.length > 500 ? "..." : ""}`
        : "";
      const errorText = `⚠️ Command exited with code ${code ?? "unknown"}${signal ? ` (${signal})` : ""}${partialOut}`;
      return {
        payload: { text: errorText },
        meta: {
          durationMs: Date.now() - started,
          queuedMs,
          queuedAhead,
          exitCode: code,
          signal,
          killed,
          agentMeta: parsed?.meta,
        },
      };
    }
    if (killed && !signal) {
      console.error(
        `Command auto-reply process killed before completion (exit code ${code ?? "unknown"})`,
      );
      const errorText = `⚠️ Command was killed before completion (exit code ${code ?? "unknown"})`;
      return {
        payload: { text: errorText },
        meta: {
          durationMs: Date.now() - started,
          queuedMs,
          queuedAhead,
          exitCode: code,
          signal,
          killed,
          agentMeta: parsed?.meta,
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
      agentMeta: parsed?.meta,
    };
    verboseLog(`Command auto-reply meta: ${JSON.stringify(meta)}`);
    return { payload, meta };
  } catch (err) {
    const elapsed = Date.now() - started;
    logger.info(
      { durationMs: elapsed, agent: agentKind, cwd: reply.cwd },
      "command auto-reply failed",
    );
    const anyErr = err as { killed?: boolean; signal?: string };
    const timeoutHit = anyErr.killed === true || anyErr.signal === "SIGKILL";
    const errorObj = err as { stdout?: string; stderr?: string };
    if (errorObj.stderr?.trim()) {
      verboseLog(`Command auto-reply stderr: ${errorObj.stderr.trim()}`);
    }
    if (timeoutHit) {
      console.error(
        `Command auto-reply timed out after ${elapsed}ms (limit ${timeoutMs}ms)`,
      );
      const baseMsg =
        "Command timed out after " +
        `${timeoutSeconds}s${reply.cwd ? ` (cwd: ${reply.cwd})` : ""}. Try a shorter prompt or split the request.`;
      const partial = errorObj.stdout?.trim();
      const partialSnippet =
        partial && partial.length > 800
          ? `${partial.slice(0, 800)}...`
          : partial;
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
    // Send error message to user so they know the command failed
    const errMsg = err instanceof Error ? err.message : String(err);
    const errorText = `⚠️ Command failed: ${errMsg}`;
    return {
      payload: { text: errorText },
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
