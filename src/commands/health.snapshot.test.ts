import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { HealthSummary } from "./health.js";
import { getHealthSnapshot } from "./health.js";

let testConfig: Record<string, unknown> = {};
let testStore: Record<string, { updatedAt?: number }> = {};

vi.mock("../config/config.js", () => ({
  loadConfig: () => testConfig,
}));

vi.mock("../config/sessions.js", () => ({
  resolveStorePath: () => "/tmp/sessions.json",
  loadSessionStore: () => testStore,
}));

vi.mock("../web/session.js", () => ({
  webAuthExists: vi.fn(async () => true),
  getWebAuthAgeMs: vi.fn(() => 1234),
  logWebSelfId: vi.fn(),
}));

vi.mock("../web/reconnect.js", () => ({
  resolveHeartbeatSeconds: vi.fn(() => 60),
}));

describe("getHealthSnapshot", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("skips telegram probe when not configured", async () => {
    testConfig = { session: { store: "/tmp/x" } };
    testStore = {
      global: { updatedAt: Date.now() },
      unknown: { updatedAt: Date.now() },
      main: { updatedAt: 1000 },
      foo: { updatedAt: 2000 },
    };
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    vi.stubEnv("DISCORD_BOT_TOKEN", "");
    const snap = (await getHealthSnapshot(10)) satisfies HealthSummary;
    expect(snap.ok).toBe(true);
    expect(snap.telegram.configured).toBe(false);
    expect(snap.telegram.probe).toBeUndefined();
    expect(snap.sessions.count).toBe(2);
    expect(snap.sessions.recent[0]?.key).toBe("foo");
  });

  it("probes telegram getMe + webhook info when configured", async () => {
    testConfig = { telegram: { botToken: "t-1" } };
    testStore = {};
    vi.stubEnv("DISCORD_BOT_TOKEN", "");

    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        if (url.includes("/getMe")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              result: { id: 1, username: "bot" },
            }),
          } as unknown as Response;
        }
        if (url.includes("/getWebhookInfo")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              result: {
                url: "https://example.com/h",
                has_custom_certificate: false,
              },
            }),
          } as unknown as Response;
        }
        return {
          ok: false,
          status: 404,
          json: async () => ({ ok: false, description: "nope" }),
        } as unknown as Response;
      }),
    );

    const snap = await getHealthSnapshot(25);
    expect(snap.telegram.configured).toBe(true);
    expect(snap.telegram.probe?.ok).toBe(true);
    expect(snap.telegram.probe?.bot?.username).toBe("bot");
    expect(snap.telegram.probe?.webhook?.url).toMatch(/^https:/);
    expect(calls.some((c) => c.includes("/getMe"))).toBe(true);
    expect(calls.some((c) => c.includes("/getWebhookInfo"))).toBe(true);
  });

  it("treats telegram.tokenFile as configured", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawdis-health-"));
    const tokenFile = path.join(tmpDir, "telegram-token");
    fs.writeFileSync(tokenFile, "t-file\n", "utf-8");
    testConfig = { telegram: { tokenFile } };
    testStore = {};

    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        if (url.includes("/getMe")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              result: { id: 1, username: "bot" },
            }),
          } as unknown as Response;
        }
        if (url.includes("/getWebhookInfo")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              result: {
                url: "https://example.com/h",
                has_custom_certificate: false,
              },
            }),
          } as unknown as Response;
        }
        return {
          ok: false,
          status: 404,
          json: async () => ({ ok: false, description: "nope" }),
        } as unknown as Response;
      }),
    );

    const snap = await getHealthSnapshot(25);
    expect(snap.telegram.configured).toBe(true);
    expect(snap.telegram.probe?.ok).toBe(true);
    expect(calls.some((c) => c.includes("bott-file/getMe"))).toBe(true);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns a structured telegram probe error when getMe fails", async () => {
    testConfig = { telegram: { botToken: "bad-token" } };
    testStore = {};
    vi.stubEnv("DISCORD_BOT_TOKEN", "");

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/getMe")) {
          return {
            ok: false,
            status: 401,
            json: async () => ({ ok: false, description: "unauthorized" }),
          } as unknown as Response;
        }
        throw new Error("unexpected");
      }),
    );

    const snap = await getHealthSnapshot(25);
    expect(snap.telegram.configured).toBe(true);
    expect(snap.telegram.probe?.ok).toBe(false);
    expect(snap.telegram.probe?.status).toBe(401);
    expect(snap.telegram.probe?.error).toMatch(/unauthorized/i);
  });

  it("captures unexpected probe exceptions as errors", async () => {
    testConfig = { telegram: { botToken: "t-err" } };
    testStore = {};
    vi.stubEnv("DISCORD_BOT_TOKEN", "");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    const snap = await getHealthSnapshot(25);
    expect(snap.telegram.configured).toBe(true);
    expect(snap.telegram.probe?.ok).toBe(false);
    expect(snap.telegram.probe?.error).toMatch(/network down/i);
  });
});
