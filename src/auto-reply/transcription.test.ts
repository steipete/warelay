import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { transcribeInboundAudio } from "./transcription.js";

vi.mock("../globals.js", () => ({
  isVerbose: () => false,
  logVerbose: vi.fn(),
}));

vi.mock("../process/exec.js", () => ({
  runExec: vi.fn(async () => ({ stdout: "transcribed text\n" })),
}));

const runtime = {
  error: vi.fn(),
};

describe("transcribeInboundAudio", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("downloads mediaUrl to temp file and returns transcript", async () => {
    const tmpBuf = Buffer.from("audio-bytes");
    const tmpFile = path.join(os.tmpdir(), `warelay-audio-${Date.now()}.ogg`);
    await fs.writeFile(tmpFile, tmpBuf);

    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => tmpBuf,
    })) as unknown as typeof fetch;
    // @ts-expect-error override global fetch for test
    global.fetch = fetchMock;

    const cfg = {
      inbound: {
        transcribeAudio: {
          command: ["echo", "{{MediaPath}}"],
          timeoutSeconds: 5,
        },
      },
    };
    const ctx = { MediaUrl: "https://example.com/audio.ogg" };

    const result = await transcribeInboundAudio(
      cfg as never,
      ctx as never,
      runtime as never,
    );
    expect(result?.text).toBe("transcribed text");
    expect(fetchMock).toHaveBeenCalled();
  });

  it("returns undefined when no transcription command", async () => {
    const res = await transcribeInboundAudio({ inbound: {} } as never, {} as never, runtime as never);
    expect(res).toBeUndefined();
  });
});
