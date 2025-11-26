import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { runCommandReply, summarizeClaudeMetadata } from "./command-reply.js";
import type { ReplyPayload } from "./types.js";

const noopTemplateCtx = {
  Body: "hello",
  BodyStripped: "hello",
  SessionId: "sess",
  IsNewSession: "true",
};

type RunnerResult = {
  stdout?: string;
  stderr?: string;
  code?: number;
  signal?: string | null;
  killed?: boolean;
};

function makeRunner(result: RunnerResult, capture: ReplyPayload[] = []) {
  return vi.fn(async (argv: string[]) => {
    capture.push({ text: argv.join(" "), argv });
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      code: result.code ?? 0,
      signal: result.signal ?? null,
      killed: result.killed ?? false,
    };
  });
}

const enqueueImmediate = vi.fn(
  async <T>(task: () => Promise<T>, opts?: { onWait?: (ms: number, ahead: number) => void }) => {
    opts?.onWait?.(25, 2);
    return task();
  },
);

describe("summarizeClaudeMetadata", () => {
  it("builds concise meta string", () => {
    const meta = summarizeClaudeMetadata({
      duration_ms: 1200,
      num_turns: 3,
      total_cost_usd: 0.012345,
      usage: { server_tool_use: { a: 1, b: 2 } },
      modelUsage: { "claude-3": 2, "haiku": 1 },
    });
    expect(meta).toContain("duration=1200ms");
    expect(meta).toContain("turns=3");
    expect(meta).toContain("cost=$0.0123");
    expect(meta).toContain("tool_calls=3");
    expect(meta).toContain("models=claude-3,haiku");
  });
});

describe("runCommandReply", () => {
  it("injects claude flags and identity prefix", async () => {
    const captures: ReplyPayload[] = [];
    const runner = makeRunner({ stdout: "ok" }, captures);
    const { payload } = await runCommandReply({
      reply: {
        mode: "command",
        command: ["claude", "{{Body}}"],
        claudeOutputFormat: "json",
      },
      templatingCtx: noopTemplateCtx,
      sendSystemOnce: false,
      isNewSession: true,
      isFirstTurnInSession: true,
      systemSent: false,
      timeoutMs: 1000,
      timeoutSeconds: 1,
      commandRunner: runner,
      enqueue: enqueueImmediate,
    });

    expect(payload?.text).toBe("ok");
    const finalArgv = captures[0].argv as string[];
    expect(finalArgv).toContain("--output-format");
    expect(finalArgv).toContain("json");
    expect(finalArgv).toContain("-p");
    expect(finalArgv.at(-1)).toContain("You are Clawd (Claude)");
  });

  it("picks session resume args when not new", async () => {
    const captures: ReplyPayload[] = [];
    const runner = makeRunner({ stdout: "hi" }, captures);
    await runCommandReply({
      reply: {
        mode: "command",
        command: ["cli", "{{Body}}"],
        session: {
          sessionArgNew: ["--new", "{{SessionId}}"],
          sessionArgResume: ["--resume", "{{SessionId}}"],
        },
      },
      templatingCtx: { ...noopTemplateCtx, SessionId: "abc" },
      sendSystemOnce: true,
      isNewSession: false,
      isFirstTurnInSession: false,
      systemSent: true,
      timeoutMs: 1000,
      timeoutSeconds: 1,
      commandRunner: runner,
      enqueue: enqueueImmediate,
    });
    const argv = captures[0].argv as string[];
    expect(argv).toContain("--resume");
    expect(argv).toContain("abc");
  });

  it("returns timeout text with partial snippet", async () => {
    const runner = vi.fn(async () => {
      throw { stdout: "partial output here", killed: true, signal: "SIGKILL" };
    });
    const { payload, meta } = await runCommandReply({
      reply: { mode: "command", command: ["echo", "hi"] },
      templatingCtx: noopTemplateCtx,
      sendSystemOnce: false,
      isNewSession: true,
      isFirstTurnInSession: true,
      systemSent: false,
      timeoutMs: 10,
      timeoutSeconds: 1,
      commandRunner: runner,
      enqueue: enqueueImmediate,
    });
    expect(payload?.text).toContain("Command timed out after 1s");
    expect(payload?.text).toContain("partial output");
    expect(meta.killed).toBe(true);
  });

  it("parses MEDIA tokens and respects mediaMaxMb for local files", async () => {
    const tmp = path.join(os.tmpdir(), `warelay-test-${Date.now()}.bin`);
    const bigBuffer = Buffer.alloc(2 * 1024 * 1024, 1);
    await fs.writeFile(tmp, bigBuffer);
    const runner = makeRunner({
      stdout: `hi\nMEDIA:${tmp}\nMEDIA:https://example.com/img.jpg`,
    });
    const { payload } = await runCommandReply({
      reply: { mode: "command", command: ["echo", "hi"], mediaMaxMb: 1 },
      templatingCtx: noopTemplateCtx,
      sendSystemOnce: false,
      isNewSession: true,
      isFirstTurnInSession: true,
      systemSent: false,
      timeoutMs: 1000,
      timeoutSeconds: 1,
      commandRunner: runner,
      enqueue: enqueueImmediate,
    });
    expect(payload?.mediaUrls).toEqual(["https://example.com/img.jpg"]);
    await fs.unlink(tmp);
  });

  it("emits Claude metadata", async () => {
    const runner = makeRunner({
      stdout:
        '{"text":"hi","duration_ms":50,"total_cost_usd":0.0001,"usage":{"server_tool_use":{"a":1}}}',
    });
    const { meta } = await runCommandReply({
      reply: {
        mode: "command",
        command: ["claude", "{{Body}}"],
        claudeOutputFormat: "json",
      },
      templatingCtx: noopTemplateCtx,
      sendSystemOnce: false,
      isNewSession: true,
      isFirstTurnInSession: true,
      systemSent: false,
      timeoutMs: 1000,
      timeoutSeconds: 1,
      commandRunner: runner,
      enqueue: enqueueImmediate,
    });
    expect(meta.claudeMeta).toContain("duration=50ms");
    expect(meta.claudeMeta).toContain("tool_calls=1");
  });
});
