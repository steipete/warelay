import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { type AddressInfo, createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { agentCommand } from "../commands/agent.js";
import { readConfigFileSnapshot, writeConfigFile } from "../config/config.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { GatewayLockError } from "../infra/gateway-lock.js";
import { emitHeartbeatEvent } from "../infra/heartbeat-events.js";
import { drainSystemEvents, peekSystemEvents } from "../infra/system-events.js";
import { rawDataToString } from "../infra/ws.js";
import { PROTOCOL_VERSION } from "./protocol/index.js";
import {
  __resetModelCatalogCacheForTest,
  startGatewayServer,
} from "./server.js";

type BridgeClientInfo = {
  nodeId: string;
  displayName?: string;
  platform?: string;
  version?: string;
  remoteIp?: string;
  deviceFamily?: string;
  modelIdentifier?: string;
  caps?: string[];
  commands?: string[];
};

type BridgeStartOpts = {
  onAuthenticated?: (node: BridgeClientInfo) => Promise<void> | void;
  onDisconnected?: (node: BridgeClientInfo) => Promise<void> | void;
  onPairRequested?: (request: unknown) => Promise<void> | void;
  onEvent?: (
    nodeId: string,
    evt: { event: string; payloadJSON?: string | null },
  ) => Promise<void> | void;
  onRequest?: (
    nodeId: string,
    req: { id: string; method: string; paramsJSON?: string | null },
  ) => Promise<
    | { ok: true; payloadJSON?: string | null }
    | { ok: false; error: { code: string; message: string; details?: unknown } }
  >;
};

const bridgeStartCalls = vi.hoisted(() => [] as BridgeStartOpts[]);
const bridgeInvoke = vi.hoisted(() =>
  vi.fn(async () => ({
    type: "invoke-res",
    id: "1",
    ok: true,
    payloadJSON: JSON.stringify({ ok: true }),
    error: null,
  })),
);
const bridgeListConnected = vi.hoisted(() =>
  vi.fn(() => [] as BridgeClientInfo[]),
);
const bridgeSendEvent = vi.hoisted(() => vi.fn());
const testTailnetIPv4 = vi.hoisted(() => ({
  value: undefined as string | undefined,
}));

const piSdkMock = vi.hoisted(() => ({
  enabled: false,
  discoverCalls: 0,
  models: [] as Array<{
    id: string;
    name?: string;
    provider: string;
    contextWindow?: number;
  }>,
}));
const cronIsolatedRun = vi.hoisted(() =>
  vi.fn(async () => ({ status: "ok", summary: "ok" })),
);

vi.mock("@mariozechner/pi-coding-agent", async () => {
  const actual = await vi.importActual<
    typeof import("@mariozechner/pi-coding-agent")
  >("@mariozechner/pi-coding-agent");

  return {
    ...actual,
    discoverModels: () => {
      if (!piSdkMock.enabled) return actual.discoverModels();
      piSdkMock.discoverCalls += 1;
      return piSdkMock.models;
    },
  };
});
vi.mock("../infra/bridge/server.js", () => ({
  startNodeBridgeServer: vi.fn(async (opts: BridgeStartOpts) => {
    bridgeStartCalls.push(opts);
    return {
      port: 18790,
      close: async () => {},
      listConnected: bridgeListConnected,
      invoke: bridgeInvoke,
      sendEvent: bridgeSendEvent,
    };
  }),
}));
vi.mock("../cron/isolated-agent.js", () => ({
  runCronIsolatedAgentTurn: (...args: unknown[]) => cronIsolatedRun(...args),
}));
vi.mock("../infra/tailnet.js", () => ({
  pickPrimaryTailnetIPv4: () => testTailnetIPv4.value,
  pickPrimaryTailnetIPv6: () => undefined,
}));

let testSessionStorePath: string | undefined;
let testAllowFrom: string[] | undefined;
let testCronStorePath: string | undefined;
let testCronEnabled: boolean | undefined = false;
let testGatewayBind: "auto" | "lan" | "tailnet" | "loopback" | undefined;
let testGatewayAuth: Record<string, unknown> | undefined;
let testHooksConfig: Record<string, unknown> | undefined;
const sessionStoreSaveDelayMs = vi.hoisted(() => ({ value: 0 }));
vi.mock("../config/sessions.js", async () => {
  const actual = await vi.importActual<typeof import("../config/sessions.js")>(
    "../config/sessions.js",
  );
  return {
    ...actual,
    saveSessionStore: vi.fn(async (storePath: string, store: unknown) => {
      const delay = sessionStoreSaveDelayMs.value;
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      return actual.saveSessionStore(storePath, store as never);
    }),
  };
});
vi.mock("../config/config.js", () => {
  const resolveConfigPath = () =>
    path.join(os.homedir(), ".clawdis", "clawdis.json");

  const readConfigFileSnapshot = async () => {
    const configPath = resolveConfigPath();
    try {
      await fs.access(configPath);
    } catch {
      return {
        path: configPath,
        exists: false,
        raw: null,
        parsed: {},
        valid: true,
        config: {},
        issues: [],
      };
    }
    try {
      const raw = await fs.readFile(configPath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return {
        path: configPath,
        exists: true,
        raw,
        parsed,
        valid: true,
        config: parsed,
        issues: [],
      };
    } catch (err) {
      return {
        path: configPath,
        exists: true,
        raw: null,
        parsed: {},
        valid: false,
        config: {},
        issues: [{ path: "", message: `read failed: ${String(err)}` }],
      };
    }
  };

  const writeConfigFile = async (cfg: Record<string, unknown>) => {
    const configPath = resolveConfigPath();
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    const raw = JSON.stringify(cfg, null, 2).trimEnd().concat("\n");
    await fs.writeFile(configPath, raw, "utf-8");
  };

  return {
    CONFIG_PATH_CLAWDIS: resolveConfigPath(),
    isNixMode: false,
    loadConfig: () => ({
      agent: {
        model: "anthropic/claude-opus-4-5",
        workspace: path.join(os.tmpdir(), "clawd-gateway-test"),
      },
      routing: {
        allowFrom: testAllowFrom,
      },
      session: { mainKey: "main", store: testSessionStorePath },
      gateway: (() => {
        const gateway: Record<string, unknown> = {};
        if (testGatewayBind) gateway.bind = testGatewayBind;
        if (testGatewayAuth) gateway.auth = testGatewayAuth;
        return Object.keys(gateway).length > 0 ? gateway : undefined;
      })(),
      hooks: testHooksConfig,
      cron: (() => {
        const cron: Record<string, unknown> = {};
        if (typeof testCronEnabled === "boolean")
          cron.enabled = testCronEnabled;
        if (typeof testCronStorePath === "string")
          cron.store = testCronStorePath;
        return Object.keys(cron).length > 0 ? cron : undefined;
      })(),
    }),
    parseConfigJson5: (raw: string) => {
      try {
        return { ok: true, parsed: JSON.parse(raw) as unknown };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },
    validateConfigObject: (parsed: unknown) => ({
      ok: true,
      config: parsed as Record<string, unknown>,
      issues: [],
    }),
    readConfigFileSnapshot,
    writeConfigFile,
  };
});

vi.mock("../commands/health.js", () => ({
  getHealthSnapshot: vi.fn().mockResolvedValue({ ok: true, stub: true }),
}));
vi.mock("../commands/status.js", () => ({
  getStatusSummary: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock("../web/outbound.js", () => ({
  sendMessageWhatsApp: vi
    .fn()
    .mockResolvedValue({ messageId: "msg-1", toJid: "jid-1" }),
}));
vi.mock("../commands/agent.js", () => ({
  agentCommand: vi.fn().mockResolvedValue(undefined),
}));

process.env.CLAWDIS_SKIP_PROVIDERS = "1";

let previousHome: string | undefined;
let tempHome: string | undefined;

beforeEach(async () => {
  previousHome = process.env.HOME;
  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "clawdis-gateway-home-"));
  process.env.HOME = tempHome;
  sessionStoreSaveDelayMs.value = 0;
  testTailnetIPv4.value = undefined;
  testGatewayBind = undefined;
  testGatewayAuth = undefined;
  testHooksConfig = undefined;
  cronIsolatedRun.mockClear();
  drainSystemEvents();
  __resetModelCatalogCacheForTest();
  piSdkMock.enabled = false;
  piSdkMock.discoverCalls = 0;
  piSdkMock.models = [];
});

afterEach(async () => {
  process.env.HOME = previousHome;
  if (tempHome) {
    await fs.rm(tempHome, { recursive: true, force: true });
    tempHome = undefined;
  }
});

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function occupyPort(): Promise<{
  server: ReturnType<typeof createServer>;
  port: number;
}> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, port });
    });
  });
}

function onceMessage<T = unknown>(
  ws: WebSocket,
  filter: (obj: unknown) => boolean,
  timeoutMs = 3000,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    const closeHandler = (code: number, reason: Buffer) => {
      clearTimeout(timer);
      ws.off("message", handler);
      reject(new Error(`closed ${code}: ${reason.toString()}`));
    };
    const handler = (data: WebSocket.RawData) => {
      const obj = JSON.parse(rawDataToString(data));
      if (filter(obj)) {
        clearTimeout(timer);
        ws.off("message", handler);
        ws.off("close", closeHandler);
        resolve(obj as T);
      }
    };
    ws.on("message", handler);
    ws.once("close", closeHandler);
  });
}

async function startServerWithClient(token?: string) {
  const port = await getFreePort();
  const prev = process.env.CLAWDIS_GATEWAY_TOKEN;
  if (token === undefined) {
    delete process.env.CLAWDIS_GATEWAY_TOKEN;
  } else {
    process.env.CLAWDIS_GATEWAY_TOKEN = token;
  }
  const server = await startGatewayServer(port);
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve) => ws.once("open", resolve));
  return { server, ws, port, prevToken: prev };
}

type ConnectResponse = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { message?: string };
};

async function connectReq(
  ws: WebSocket,
  opts?: {
    token?: string;
    password?: string;
    minProtocol?: number;
    maxProtocol?: number;
    client?: {
      name: string;
      version: string;
      platform: string;
      mode: string;
      instanceId?: string;
    };
  },
): Promise<ConnectResponse> {
  const id = randomUUID();
  ws.send(
    JSON.stringify({
      type: "req",
      id,
      method: "connect",
      params: {
        minProtocol: opts?.minProtocol ?? PROTOCOL_VERSION,
        maxProtocol: opts?.maxProtocol ?? PROTOCOL_VERSION,
        client: opts?.client ?? {
          name: "test",
          version: "1.0.0",
          platform: "test",
          mode: "test",
        },
        caps: [],
        auth:
          opts?.token || opts?.password
            ? {
                token: opts?.token,
                password: opts?.password,
              }
            : undefined,
      },
    }),
  );
  return await onceMessage<ConnectResponse>(
    ws,
    (o) => o.type === "res" && o.id === id,
  );
}

async function connectOk(
  ws: WebSocket,
  opts?: Parameters<typeof connectReq>[1],
) {
  const res = await connectReq(ws, opts);
  expect(res.ok).toBe(true);
  expect((res.payload as { type?: unknown } | undefined)?.type).toBe(
    "hello-ok",
  );
  return res.payload as { type: "hello-ok" };
}

async function rpcReq<T = unknown>(
  ws: WebSocket,
  method: string,
  params?: unknown,
) {
  const id = randomUUID();
  ws.send(JSON.stringify({ type: "req", id, method, params }));
  return await onceMessage<{
    type: "res";
    id: string;
    ok: boolean;
    payload?: T;
    error?: { message?: string };
  }>(ws, (o) => o.type === "res" && o.id === id);
}

async function waitForSystemEvent(timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = peekSystemEvents();
    if (events.length > 0) return events;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timeout waiting for system event");
}

describe("gateway server", () => {
  test("voicewake.get returns defaults and voicewake.set broadcasts", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdis-home-"));
    const prevHome = process.env.HOME;
    process.env.HOME = homeDir;

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const initial = await rpcReq<{ triggers: string[] }>(ws, "voicewake.get");
    expect(initial.ok).toBe(true);
    expect(initial.payload?.triggers).toEqual(["clawd", "claude", "computer"]);

    const changedP = onceMessage<{
      type: "event";
      event: string;
      payload?: unknown;
    }>(ws, (o) => o.type === "event" && o.event === "voicewake.changed");

    const setRes = await rpcReq<{ triggers: string[] }>(ws, "voicewake.set", {
      triggers: ["  hi  ", "", "there"],
    });
    expect(setRes.ok).toBe(true);
    expect(setRes.payload?.triggers).toEqual(["hi", "there"]);

    const changed = await changedP;
    expect(changed.event).toBe("voicewake.changed");
    expect(
      (changed.payload as { triggers?: unknown } | undefined)?.triggers,
    ).toEqual(["hi", "there"]);

    const after = await rpcReq<{ triggers: string[] }>(ws, "voicewake.get");
    expect(after.ok).toBe(true);
    expect(after.payload?.triggers).toEqual(["hi", "there"]);

    const onDisk = JSON.parse(
      await fs.readFile(
        path.join(homeDir, ".clawdis", "settings", "voicewake.json"),
        "utf8",
      ),
    ) as { triggers?: unknown; updatedAtMs?: unknown };
    expect(onDisk.triggers).toEqual(["hi", "there"]);
    expect(typeof onDisk.updatedAtMs).toBe("number");

    ws.close();
    await server.close();

    if (prevHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = prevHome;
    }
  });

  test("models.list returns model catalog", async () => {
    piSdkMock.enabled = true;
    piSdkMock.models = [
      { id: "gpt-test-z", provider: "openai", contextWindow: 0 },
      {
        id: "gpt-test-a",
        name: "A-Model",
        provider: "openai",
        contextWindow: 8000,
      },
      {
        id: "claude-test-b",
        name: "B-Model",
        provider: "anthropic",
        contextWindow: 1000,
      },
      {
        id: "claude-test-a",
        name: "A-Model",
        provider: "anthropic",
        contextWindow: 200_000,
      },
    ];

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const res1 = await rpcReq<{
      models: Array<{
        id: string;
        name: string;
        provider: string;
        contextWindow?: number;
      }>;
    }>(ws, "models.list");

    const res2 = await rpcReq<{
      models: Array<{
        id: string;
        name: string;
        provider: string;
        contextWindow?: number;
      }>;
    }>(ws, "models.list");

    expect(res1.ok).toBe(true);
    expect(res2.ok).toBe(true);

    const models = res1.payload?.models ?? [];
    expect(models).toEqual([
      {
        id: "claude-test-a",
        name: "A-Model",
        provider: "anthropic",
        contextWindow: 200_000,
      },
      {
        id: "claude-test-b",
        name: "B-Model",
        provider: "anthropic",
        contextWindow: 1000,
      },
      {
        id: "gpt-test-a",
        name: "A-Model",
        provider: "openai",
        contextWindow: 8000,
      },
      {
        id: "gpt-test-z",
        name: "gpt-test-z",
        provider: "openai",
      },
    ]);

    // Cached across requests: should only call discoverModels once.
    expect(piSdkMock.discoverCalls).toBe(1);

    ws.close();
    await server.close();
  });

  test("models.list rejects unknown params", async () => {
    piSdkMock.enabled = true;
    piSdkMock.models = [{ id: "gpt-test-a", name: "A", provider: "openai" }];

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const res = await rpcReq(ws, "models.list", { extra: true });
    expect(res.ok).toBe(false);
    expect(res.error?.message ?? "").toMatch(/invalid models\.list params/i);

    ws.close();
    await server.close();
  });

  test("bridge RPC supports models.list and validates params", async () => {
    piSdkMock.enabled = true;
    piSdkMock.models = [{ id: "gpt-test-a", name: "A", provider: "openai" }];

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const startCall = bridgeStartCalls.at(-1);
    expect(startCall).toBeTruthy();

    const okRes = await startCall?.onRequest?.("n1", {
      id: "1",
      method: "models.list",
      paramsJSON: "{}",
    });
    expect(okRes?.ok).toBe(true);
    const okPayload = JSON.parse(String(okRes?.payloadJSON ?? "{}")) as {
      models?: unknown;
    };
    expect(Array.isArray(okPayload.models)).toBe(true);

    const badRes = await startCall?.onRequest?.("n1", {
      id: "2",
      method: "models.list",
      paramsJSON: JSON.stringify({ extra: true }),
    });
    expect(badRes?.ok).toBe(false);
    expect(badRes && "error" in badRes ? badRes.error.code : "").toBe(
      "INVALID_REQUEST",
    );

    ws.close();
    await server.close();
  });

  test("pushes voicewake.changed to nodes on connect and on updates", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdis-home-"));
    const prevHome = process.env.HOME;
    process.env.HOME = homeDir;

    bridgeSendEvent.mockClear();
    bridgeListConnected.mockReturnValue([{ nodeId: "n1" }]);

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const startCall = bridgeStartCalls.at(-1);
    expect(startCall).toBeTruthy();

    await startCall?.onAuthenticated?.({ nodeId: "n1" });

    const first = bridgeSendEvent.mock.calls.find(
      (c) => c[0]?.event === "voicewake.changed" && c[0]?.nodeId === "n1",
    )?.[0] as { payloadJSON?: string | null } | undefined;
    expect(first?.payloadJSON).toBeTruthy();
    const firstPayload = JSON.parse(String(first?.payloadJSON)) as {
      triggers?: unknown;
    };
    expect(firstPayload.triggers).toEqual(["clawd", "claude", "computer"]);

    bridgeSendEvent.mockClear();

    const setRes = await rpcReq<{ triggers: string[] }>(ws, "voicewake.set", {
      triggers: ["clawd", "computer"],
    });
    expect(setRes.ok).toBe(true);

    const broadcast = bridgeSendEvent.mock.calls.find(
      (c) => c[0]?.event === "voicewake.changed" && c[0]?.nodeId === "n1",
    )?.[0] as { payloadJSON?: string | null } | undefined;
    expect(broadcast?.payloadJSON).toBeTruthy();
    const broadcastPayload = JSON.parse(String(broadcast?.payloadJSON)) as {
      triggers?: unknown;
    };
    expect(broadcastPayload.triggers).toEqual(["clawd", "computer"]);

    ws.close();
    await server.close();

    if (prevHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = prevHome;
    }
  });

  test("supports gateway-owned node pairing methods and events", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdis-home-"));
    const prevHome = process.env.HOME;
    process.env.HOME = homeDir;

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const requestedP = onceMessage<{
      type: "event";
      event: string;
      payload?: unknown;
    }>(ws, (o) => o.type === "event" && o.event === "node.pair.requested");

    ws.send(
      JSON.stringify({
        type: "req",
        id: "pair-req-1",
        method: "node.pair.request",
        params: { nodeId: "n1", displayName: "Node" },
      }),
    );
    const res1 = await onceMessage<{
      type: "res";
      ok: boolean;
      payload?: unknown;
    }>(ws, (o) => o.type === "res" && o.id === "pair-req-1");
    expect(res1.ok).toBe(true);
    const req1 = (res1.payload as { request?: { requestId?: unknown } } | null)
      ?.request;
    const requestId = typeof req1?.requestId === "string" ? req1.requestId : "";
    expect(requestId.length).toBeGreaterThan(0);

    const evt1 = await requestedP;
    expect(evt1.event).toBe("node.pair.requested");
    expect((evt1.payload as { requestId?: unknown } | null)?.requestId).toBe(
      requestId,
    );

    // Second request for same node should return the existing pending request
    // without emitting a second requested event.
    ws.send(
      JSON.stringify({
        type: "req",
        id: "pair-req-2",
        method: "node.pair.request",
        params: { nodeId: "n1", displayName: "Node" },
      }),
    );
    const res2 = await onceMessage<{
      type: "res";
      ok: boolean;
      payload?: unknown;
    }>(ws, (o) => o.type === "res" && o.id === "pair-req-2");
    expect(res2.ok).toBe(true);
    await expect(
      onceMessage(
        ws,
        (o) => o.type === "event" && o.event === "node.pair.requested",
        200,
      ),
    ).rejects.toThrow();

    const resolvedP = onceMessage<{
      type: "event";
      event: string;
      payload?: unknown;
    }>(ws, (o) => o.type === "event" && o.event === "node.pair.resolved");

    ws.send(
      JSON.stringify({
        type: "req",
        id: "pair-approve-1",
        method: "node.pair.approve",
        params: { requestId },
      }),
    );
    const approveRes = await onceMessage<{
      type: "res";
      ok: boolean;
      payload?: unknown;
    }>(ws, (o) => o.type === "res" && o.id === "pair-approve-1");
    expect(approveRes.ok).toBe(true);
    const tokenValue = (
      approveRes.payload as { node?: { token?: unknown } } | null
    )?.node?.token;
    const token = typeof tokenValue === "string" ? tokenValue : "";
    expect(token.length).toBeGreaterThan(0);

    const evt2 = await resolvedP;
    expect((evt2.payload as { requestId?: unknown } | null)?.requestId).toBe(
      requestId,
    );
    expect((evt2.payload as { decision?: unknown } | null)?.decision).toBe(
      "approved",
    );

    ws.send(
      JSON.stringify({
        type: "req",
        id: "pair-verify-1",
        method: "node.pair.verify",
        params: { nodeId: "n1", token },
      }),
    );
    const verifyRes = await onceMessage<{
      type: "res";
      ok: boolean;
      payload?: unknown;
    }>(ws, (o) => o.type === "res" && o.id === "pair-verify-1");
    expect(verifyRes.ok).toBe(true);
    expect((verifyRes.payload as { ok?: unknown } | null)?.ok).toBe(true);

    ws.send(
      JSON.stringify({
        type: "req",
        id: "pair-list-1",
        method: "node.pair.list",
        params: {},
      }),
    );
    const listRes = await onceMessage<{
      type: "res";
      ok: boolean;
      payload?: unknown;
    }>(ws, (o) => o.type === "res" && o.id === "pair-list-1");
    expect(listRes.ok).toBe(true);
    const paired = (listRes.payload as { paired?: unknown } | null)?.paired;
    expect(Array.isArray(paired)).toBe(true);
    expect(
      (paired as Array<{ nodeId?: unknown }>).some((n) => n.nodeId === "n1"),
    ).toBe(true);

    ws.close();
    await server.close();
    await fs.rm(homeDir, { recursive: true, force: true });
    if (prevHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = prevHome;
    }
  });

  test("routes node.invoke to the node bridge", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdis-home-"));
    const prevHome = process.env.HOME;
    process.env.HOME = homeDir;

    try {
      bridgeInvoke.mockResolvedValueOnce({
        type: "invoke-res",
        id: "inv-1",
        ok: true,
        payloadJSON: JSON.stringify({ result: "4" }),
        error: null,
      });

      const { server, ws } = await startServerWithClient();
      try {
        await connectOk(ws);

        const res = await rpcReq(ws, "node.invoke", {
          nodeId: "ios-node",
          command: "canvas.eval",
          params: { javaScript: "2+2" },
          timeoutMs: 123,
          idempotencyKey: "idem-1",
        });
        expect(res.ok).toBe(true);

        expect(bridgeInvoke).toHaveBeenCalledWith(
          expect.objectContaining({
            nodeId: "ios-node",
            command: "canvas.eval",
            paramsJSON: JSON.stringify({ javaScript: "2+2" }),
            timeoutMs: 123,
          }),
        );
      } finally {
        ws.close();
        await server.close();
      }
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
      if (prevHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = prevHome;
      }
    }
  });

  test("node.describe returns supported invoke commands for paired nodes", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdis-home-"));
    const prevHome = process.env.HOME;
    process.env.HOME = homeDir;

    try {
      const { server, ws } = await startServerWithClient();
      try {
        await connectOk(ws);

        const reqRes = await rpcReq<{
          status?: string;
          request?: { requestId?: string };
        }>(ws, "node.pair.request", {
          nodeId: "n1",
          displayName: "iPad",
          platform: "iPadOS",
          version: "dev",
          deviceFamily: "iPad",
          modelIdentifier: "iPad16,6",
          caps: ["canvas", "camera"],
          commands: ["canvas.eval", "canvas.snapshot", "camera.snap"],
          remoteIp: "10.0.0.10",
        });
        expect(reqRes.ok).toBe(true);
        const requestId = reqRes.payload?.request?.requestId;
        expect(typeof requestId).toBe("string");

        const approveRes = await rpcReq(ws, "node.pair.approve", {
          requestId,
        });
        expect(approveRes.ok).toBe(true);

        const describeRes = await rpcReq<{ commands?: string[] }>(
          ws,
          "node.describe",
          { nodeId: "n1" },
        );
        expect(describeRes.ok).toBe(true);
        expect(describeRes.payload?.commands).toEqual([
          "camera.snap",
          "canvas.eval",
          "canvas.snapshot",
        ]);
      } finally {
        ws.close();
        await server.close();
      }
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
      if (prevHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = prevHome;
      }
    }
  });

  test("node.describe works for connected unpaired nodes (caps + commands)", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdis-home-"));
    const prevHome = process.env.HOME;
    process.env.HOME = homeDir;

    try {
      const { server, ws } = await startServerWithClient();
      try {
        await connectOk(ws);

        bridgeListConnected.mockReturnValueOnce([
          {
            nodeId: "u1",
            displayName: "Unpaired Live",
            platform: "Android",
            version: "dev-live",
            remoteIp: "10.0.0.12",
            deviceFamily: "Android",
            modelIdentifier: "samsung SM-X926B",
            caps: ["canvas", "camera", "canvas"],
            commands: ["canvas.eval", "camera.snap", "canvas.eval"],
          },
        ]);

        const describeRes = await rpcReq<{
          paired?: boolean;
          connected?: boolean;
          caps?: string[];
          commands?: string[];
          deviceFamily?: string;
          modelIdentifier?: string;
          remoteIp?: string;
        }>(ws, "node.describe", { nodeId: "u1" });
        expect(describeRes.ok).toBe(true);
        expect(describeRes.payload).toMatchObject({
          paired: false,
          connected: true,
          deviceFamily: "Android",
          modelIdentifier: "samsung SM-X926B",
          remoteIp: "10.0.0.12",
        });
        expect(describeRes.payload?.caps).toEqual(["camera", "canvas"]);
        expect(describeRes.payload?.commands).toEqual([
          "camera.snap",
          "canvas.eval",
        ]);
      } finally {
        ws.close();
        await server.close();
      }
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
      if (prevHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = prevHome;
      }
    }
  });

  test("node.list includes connected unpaired nodes with capabilities + commands", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdis-home-"));
    const prevHome = process.env.HOME;
    process.env.HOME = homeDir;

    try {
      const { server, ws } = await startServerWithClient();
      try {
        await connectOk(ws);

        const reqRes = await rpcReq<{
          status?: string;
          request?: { requestId?: string };
        }>(ws, "node.pair.request", {
          nodeId: "p1",
          displayName: "Paired",
          platform: "iPadOS",
          version: "dev",
          deviceFamily: "iPad",
          modelIdentifier: "iPad16,6",
          caps: ["canvas"],
          commands: ["canvas.eval"],
          remoteIp: "10.0.0.10",
        });
        expect(reqRes.ok).toBe(true);
        const requestId = reqRes.payload?.request?.requestId;
        expect(typeof requestId).toBe("string");

        const approveRes = await rpcReq(ws, "node.pair.approve", { requestId });
        expect(approveRes.ok).toBe(true);

        bridgeListConnected.mockReturnValueOnce([
          {
            nodeId: "p1",
            displayName: "Paired Live",
            platform: "iPadOS",
            version: "dev-live",
            remoteIp: "10.0.0.11",
            deviceFamily: "iPad",
            modelIdentifier: "iPad16,6",
            caps: ["canvas", "camera"],
            commands: ["canvas.snapshot", "canvas.eval"],
          },
          {
            nodeId: "u1",
            displayName: "Unpaired Live",
            platform: "Android",
            version: "dev",
            remoteIp: "10.0.0.12",
            deviceFamily: "Android",
            modelIdentifier: "samsung SM-X926B",
            caps: ["canvas"],
            commands: ["canvas.eval"],
          },
        ]);

        const listRes = await rpcReq<{
          nodes?: Array<{
            nodeId: string;
            paired?: boolean;
            connected?: boolean;
            caps?: string[];
            commands?: string[];
            displayName?: string;
            remoteIp?: string;
          }>;
        }>(ws, "node.list", {});
        expect(listRes.ok).toBe(true);
        const nodes = listRes.payload?.nodes ?? [];

        const pairedNode = nodes.find((n) => n.nodeId === "p1");
        expect(pairedNode).toMatchObject({
          nodeId: "p1",
          paired: true,
          connected: true,
          displayName: "Paired Live",
          remoteIp: "10.0.0.11",
        });
        expect(pairedNode?.caps?.slice().sort()).toEqual(["camera", "canvas"]);
        expect(pairedNode?.commands?.slice().sort()).toEqual([
          "canvas.eval",
          "canvas.snapshot",
        ]);

        const unpairedNode = nodes.find((n) => n.nodeId === "u1");
        expect(unpairedNode).toMatchObject({
          nodeId: "u1",
          paired: false,
          connected: true,
          displayName: "Unpaired Live",
        });
        expect(unpairedNode?.caps).toEqual(["canvas"]);
        expect(unpairedNode?.commands).toEqual(["canvas.eval"]);
      } finally {
        ws.close();
        await server.close();
      }
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
      if (prevHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = prevHome;
      }
    }
  });

  test("emits presence updates for bridge connect/disconnect", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdis-home-"));
    const prevHome = process.env.HOME;
    process.env.HOME = homeDir;
    try {
      const before = bridgeStartCalls.length;
      const { server, ws } = await startServerWithClient();
      try {
        await connectOk(ws);
        const bridgeCall = bridgeStartCalls[before];
        expect(bridgeCall).toBeTruthy();

        const waitPresenceReason = async (reason: string) => {
          await onceMessage(
            ws,
            (o) => {
              if (o.type !== "event" || o.event !== "presence") return false;
              const payload = o.payload as { presence?: unknown } | null;
              const list = payload?.presence;
              if (!Array.isArray(list)) return false;
              return list.some(
                (p) =>
                  typeof p === "object" &&
                  p !== null &&
                  (p as { instanceId?: unknown }).instanceId === "node-1" &&
                  (p as { reason?: unknown }).reason === reason,
              );
            },
            3000,
          );
        };

        const presenceConnectedP = waitPresenceReason("node-connected");
        await bridgeCall?.onAuthenticated?.({
          nodeId: "node-1",
          displayName: "Node",
          platform: "ios",
          version: "1.0",
          remoteIp: "10.0.0.10",
        });
        await presenceConnectedP;

        const presenceDisconnectedP = waitPresenceReason("node-disconnected");
        await bridgeCall?.onDisconnected?.({
          nodeId: "node-1",
          displayName: "Node",
          platform: "ios",
          version: "1.0",
          remoteIp: "10.0.0.10",
        });
        await presenceDisconnectedP;
      } finally {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        await server.close();
        await fs.rm(homeDir, { recursive: true, force: true });
      }
    } finally {
      if (prevHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = prevHome;
      }
    }
  });

  test("supports cron.add and cron.list", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdis-gw-cron-"));
    testCronStorePath = path.join(dir, "cron", "jobs.json");
    await fs.mkdir(path.dirname(testCronStorePath), { recursive: true });
    await fs.writeFile(
      testCronStorePath,
      JSON.stringify({ version: 1, jobs: [] }),
    );

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    ws.send(
      JSON.stringify({
        type: "req",
        id: "cron-add-1",
        method: "cron.add",
        params: {
          name: "daily",
          enabled: true,
          schedule: { kind: "every", everyMs: 60_000 },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "hello" },
        },
      }),
    );
    const addRes = await onceMessage<{
      type: "res";
      ok: boolean;
      payload?: unknown;
    }>(ws, (o) => o.type === "res" && o.id === "cron-add-1");
    expect(addRes.ok).toBe(true);
    expect(typeof (addRes.payload as { id?: unknown } | null)?.id).toBe(
      "string",
    );

    ws.send(
      JSON.stringify({
        type: "req",
        id: "cron-list-1",
        method: "cron.list",
        params: { includeDisabled: true },
      }),
    );
    const listRes = await onceMessage<{
      type: "res";
      ok: boolean;
      payload?: unknown;
    }>(ws, (o) => o.type === "res" && o.id === "cron-list-1");
    expect(listRes.ok).toBe(true);
    const jobs = (listRes.payload as { jobs?: unknown } | null)?.jobs;
    expect(Array.isArray(jobs)).toBe(true);
    expect((jobs as unknown[]).length).toBe(1);
    expect(((jobs as Array<{ name?: unknown }>)[0]?.name as string) ?? "").toBe(
      "daily",
    );

    ws.close();
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
    testCronStorePath = undefined;
  });

  test("writes cron run history to runs/<jobId>.jsonl", async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "clawdis-gw-cron-log-"),
    );
    testCronStorePath = path.join(dir, "cron", "jobs.json");
    await fs.mkdir(path.dirname(testCronStorePath), { recursive: true });
    await fs.writeFile(
      testCronStorePath,
      JSON.stringify({ version: 1, jobs: [] }),
    );

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const atMs = Date.now() - 1;
    ws.send(
      JSON.stringify({
        type: "req",
        id: "cron-add-log-1",
        method: "cron.add",
        params: {
          name: "log test",
          enabled: true,
          schedule: { kind: "at", atMs },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "hello" },
        },
      }),
    );

    const addRes = await onceMessage<{
      type: "res";
      ok: boolean;
      payload?: unknown;
    }>(ws, (o) => o.type === "res" && o.id === "cron-add-log-1");
    expect(addRes.ok).toBe(true);
    const jobIdValue = (addRes.payload as { id?: unknown } | null)?.id;
    const jobId = typeof jobIdValue === "string" ? jobIdValue : "";
    expect(jobId.length > 0).toBe(true);

    ws.send(
      JSON.stringify({
        type: "req",
        id: "cron-run-log-1",
        method: "cron.run",
        params: { id: jobId, mode: "force" },
      }),
    );
    const runRes = await onceMessage<{ type: "res"; ok: boolean }>(
      ws,
      (o) => o.type === "res" && o.id === "cron-run-log-1",
      8000,
    );
    expect(runRes.ok).toBe(true);

    const logPath = path.join(dir, "cron", "runs", `${jobId}.jsonl`);
    const waitForLog = async () => {
      for (let i = 0; i < 200; i++) {
        const raw = await fs.readFile(logPath, "utf-8").catch(() => "");
        if (raw.trim().length > 0) return raw;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error("timeout waiting for cron run log");
    };

    const raw = await waitForLog();
    const line = raw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .at(-1);
    const last = JSON.parse(line ?? "{}") as {
      jobId?: unknown;
      action?: unknown;
      status?: unknown;
      summary?: unknown;
    };
    expect(last.action).toBe("finished");
    expect(last.jobId).toBe(jobId);
    expect(last.status).toBe("ok");
    expect(last.summary).toBe("hello");

    ws.send(
      JSON.stringify({
        type: "req",
        id: "cron-runs-1",
        method: "cron.runs",
        params: { id: jobId, limit: 50 },
      }),
    );
    const runsRes = await onceMessage<{
      type: "res";
      ok: boolean;
      payload?: unknown;
    }>(ws, (o) => o.type === "res" && o.id === "cron-runs-1", 8000);
    expect(runsRes.ok).toBe(true);
    const entries = (runsRes.payload as { entries?: unknown } | null)?.entries;
    expect(Array.isArray(entries)).toBe(true);
    expect((entries as Array<{ jobId?: unknown }>).at(-1)?.jobId).toBe(jobId);
    expect((entries as Array<{ summary?: unknown }>).at(-1)?.summary).toBe(
      "hello",
    );

    ws.close();
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
    testCronStorePath = undefined;
  });

  test("writes cron run history to per-job runs/ when store is jobs.json", async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "clawdis-gw-cron-log-jobs-"),
    );
    const cronDir = path.join(dir, "cron");
    testCronStorePath = path.join(cronDir, "jobs.json");
    await fs.mkdir(cronDir, { recursive: true });
    await fs.writeFile(
      testCronStorePath,
      JSON.stringify({ version: 1, jobs: [] }),
    );

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const atMs = Date.now() - 1;
    ws.send(
      JSON.stringify({
        type: "req",
        id: "cron-add-log-2",
        method: "cron.add",
        params: {
          name: "log test (jobs.json)",
          enabled: true,
          schedule: { kind: "at", atMs },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "hello" },
        },
      }),
    );

    const addRes = await onceMessage<{
      type: "res";
      ok: boolean;
      payload?: unknown;
    }>(ws, (o) => o.type === "res" && o.id === "cron-add-log-2");
    expect(addRes.ok).toBe(true);
    const jobIdValue = (addRes.payload as { id?: unknown } | null)?.id;
    const jobId = typeof jobIdValue === "string" ? jobIdValue : "";
    expect(jobId.length > 0).toBe(true);

    ws.send(
      JSON.stringify({
        type: "req",
        id: "cron-run-log-2",
        method: "cron.run",
        params: { id: jobId, mode: "force" },
      }),
    );
    const runRes = await onceMessage<{ type: "res"; ok: boolean }>(
      ws,
      (o) => o.type === "res" && o.id === "cron-run-log-2",
      8000,
    );
    expect(runRes.ok).toBe(true);

    const logPath = path.join(cronDir, "runs", `${jobId}.jsonl`);
    const waitForLog = async () => {
      for (let i = 0; i < 200; i++) {
        const raw = await fs.readFile(logPath, "utf-8").catch(() => "");
        if (raw.trim().length > 0) return raw;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error("timeout waiting for per-job cron run log");
    };

    const raw = await waitForLog();
    const line = raw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .at(-1);
    const last = JSON.parse(line ?? "{}") as {
      jobId?: unknown;
      action?: unknown;
      summary?: unknown;
    };
    expect(last.action).toBe("finished");
    expect(last.jobId).toBe(jobId);
    expect(last.summary).toBe("hello");

    ws.send(
      JSON.stringify({
        type: "req",
        id: "cron-runs-2",
        method: "cron.runs",
        params: { id: jobId, limit: 20 },
      }),
    );
    const runsRes = await onceMessage<{
      type: "res";
      ok: boolean;
      payload?: unknown;
    }>(ws, (o) => o.type === "res" && o.id === "cron-runs-2", 8000);
    expect(runsRes.ok).toBe(true);
    const entries = (runsRes.payload as { entries?: unknown } | null)?.entries;
    expect(Array.isArray(entries)).toBe(true);
    expect((entries as Array<{ jobId?: unknown }>).at(-1)?.jobId).toBe(jobId);
    expect((entries as Array<{ summary?: unknown }>).at(-1)?.summary).toBe(
      "hello",
    );

    ws.close();
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
    testCronStorePath = undefined;
  });

  test("enables cron scheduler by default and runs due jobs automatically", async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "clawdis-gw-cron-default-on-"),
    );
    testCronStorePath = path.join(dir, "cron", "jobs.json");
    testCronEnabled = undefined; // omitted config => enabled by default

    try {
      await fs.mkdir(path.dirname(testCronStorePath), { recursive: true });
      await fs.writeFile(
        testCronStorePath,
        JSON.stringify({ version: 1, jobs: [] }),
      );

      const { server, ws } = await startServerWithClient();
      await connectOk(ws);

      ws.send(
        JSON.stringify({
          type: "req",
          id: "cron-status-1",
          method: "cron.status",
          params: {},
        }),
      );
      const statusRes = await onceMessage<{
        type: "res";
        id: string;
        ok: boolean;
        payload?: unknown;
      }>(ws, (o) => o.type === "res" && o.id === "cron-status-1");
      expect(statusRes.ok).toBe(true);
      const statusPayload = statusRes.payload as
        | { enabled?: unknown; storePath?: unknown }
        | undefined;
      expect(statusPayload?.enabled).toBe(true);
      const storePath =
        typeof statusPayload?.storePath === "string"
          ? statusPayload.storePath
          : "";
      expect(storePath).toContain("jobs.json");

      const atMs = Date.now() + 80;
      ws.send(
        JSON.stringify({
          type: "req",
          id: "cron-add-auto-1",
          method: "cron.add",
          params: {
            name: "auto run test",
            enabled: true,
            schedule: { kind: "at", atMs },
            sessionTarget: "main",
            wakeMode: "next-heartbeat",
            payload: { kind: "systemEvent", text: "auto" },
          },
        }),
      );
      const addRes = await onceMessage<{
        type: "res";
        ok: boolean;
        payload?: unknown;
      }>(ws, (o) => o.type === "res" && o.id === "cron-add-auto-1");
      expect(addRes.ok).toBe(true);
      const jobIdValue = (addRes.payload as { id?: unknown } | null)?.id;
      const jobId = typeof jobIdValue === "string" ? jobIdValue : "";
      expect(jobId.length > 0).toBe(true);

      const finishedEvt = await onceMessage<{
        type: "event";
        event: string;
        payload?: { jobId?: string; action?: string; status?: string } | null;
      }>(
        ws,
        (o) =>
          o.type === "event" &&
          o.event === "cron" &&
          (o.payload as { jobId?: unknown } | null)?.jobId === jobId &&
          (o.payload as { action?: unknown } | null)?.action === "finished",
        8000,
      );
      expect(finishedEvt.payload?.status).toBe("ok");

      const waitForRuns = async () => {
        for (let i = 0; i < 200; i++) {
          ws.send(
            JSON.stringify({
              type: "req",
              id: "cron-runs-auto-1",
              method: "cron.runs",
              params: { id: jobId, limit: 10 },
            }),
          );
          const runsRes = await onceMessage<{
            type: "res";
            ok: boolean;
            payload?: unknown;
          }>(ws, (o) => o.type === "res" && o.id === "cron-runs-auto-1", 8000);
          expect(runsRes.ok).toBe(true);
          const entries = (runsRes.payload as { entries?: unknown } | null)
            ?.entries;
          if (Array.isArray(entries) && entries.length > 0) return entries;
          await new Promise((r) => setTimeout(r, 10));
        }
        throw new Error("timeout waiting for cron.runs entries");
      };

      const entries = (await waitForRuns()) as Array<{ jobId?: unknown }>;
      expect(entries.at(-1)?.jobId).toBe(jobId);

      ws.close();
      await server.close();
    } finally {
      testCronEnabled = false;
      testCronStorePath = undefined;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("broadcasts heartbeat events and serves last-heartbeat", async () => {
    type HeartbeatPayload = {
      ts: number;
      status: string;
      to?: string;
      preview?: string;
      durationMs?: number;
      hasMedia?: boolean;
      reason?: string;
    };
    type EventFrame = {
      type: "event";
      event: string;
      payload?: HeartbeatPayload | null;
    };
    type ResFrame = {
      type: "res";
      id: string;
      ok: boolean;
      payload?: unknown;
    };

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const waitHeartbeat = onceMessage<EventFrame>(
      ws,
      (o) => o.type === "event" && o.event === "heartbeat",
    );
    emitHeartbeatEvent({ status: "sent", to: "+123", preview: "ping" });
    const evt = await waitHeartbeat;
    expect(evt.payload?.status).toBe("sent");
    expect(typeof evt.payload?.ts).toBe("number");

    ws.send(
      JSON.stringify({
        type: "req",
        id: "hb-last",
        method: "last-heartbeat",
      }),
    );
    const last = await onceMessage<ResFrame>(
      ws,
      (o) => o.type === "res" && o.id === "hb-last",
    );
    expect(last.ok).toBe(true);
    const lastPayload = last.payload as HeartbeatPayload | null | undefined;
    expect(lastPayload?.status).toBe("sent");
    expect(lastPayload?.ts).toBe(evt.payload?.ts);

    ws.send(
      JSON.stringify({
        type: "req",
        id: "hb-toggle-off",
        method: "set-heartbeats",
        params: { enabled: false },
      }),
    );
    const toggle = await onceMessage<ResFrame>(
      ws,
      (o) => o.type === "res" && o.id === "hb-toggle-off",
    );
    expect(toggle.ok).toBe(true);
    expect((toggle.payload as { enabled?: boolean } | undefined)?.enabled).toBe(
      false,
    );

    ws.close();
    await server.close();
  });

  test("agent falls back to allowFrom when lastTo is stale", async () => {
    testAllowFrom = ["+436769770569"];
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdis-gw-"));
    testSessionStorePath = path.join(dir, "sessions.json");
    await fs.writeFile(
      testSessionStorePath,
      JSON.stringify(
        {
          main: {
            sessionId: "sess-main-stale",
            updatedAt: Date.now(),
            lastChannel: "whatsapp",
            lastTo: "+1555",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    ws.send(
      JSON.stringify({
        type: "req",
        id: "agent-last-stale",
        method: "agent",
        params: {
          message: "hi",
          sessionKey: "main",
          channel: "last",
          deliver: true,
          idempotencyKey: "idem-agent-last-stale",
        },
      }),
    );
    await onceMessage(
      ws,
      (o) => o.type === "res" && o.id === "agent-last-stale",
    );

    const spy = vi.mocked(agentCommand);
    expect(spy).toHaveBeenCalled();
    const call = spy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(call.provider).toBe("whatsapp");
    expect(call.to).toBe("+436769770569");
    expect(call.sessionId).toBe("sess-main-stale");

    ws.close();
    await server.close();
    testAllowFrom = undefined;
  });

  test("agent routes main last-channel whatsapp", async () => {
    testAllowFrom = undefined;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdis-gw-"));
    testSessionStorePath = path.join(dir, "sessions.json");
    await fs.writeFile(
      testSessionStorePath,
      JSON.stringify(
        {
          main: {
            sessionId: "sess-main-whatsapp",
            updatedAt: Date.now(),
            lastChannel: "whatsapp",
            lastTo: "+1555",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    ws.send(
      JSON.stringify({
        type: "req",
        id: "agent-last-whatsapp",
        method: "agent",
        params: {
          message: "hi",
          sessionKey: "main",
          channel: "last",
          deliver: true,
          idempotencyKey: "idem-agent-last-whatsapp",
        },
      }),
    );
    await onceMessage(
      ws,
      (o) => o.type === "res" && o.id === "agent-last-whatsapp",
    );

    const spy = vi.mocked(agentCommand);
    expect(spy).toHaveBeenCalled();
    const call = spy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(call.provider).toBe("whatsapp");
    expect(call.to).toBe("+1555");
    expect(call.deliver).toBe(true);
    expect(call.bestEffortDeliver).toBe(true);
    expect(call.sessionId).toBe("sess-main-whatsapp");

    ws.close();
    await server.close();
  });

  test("agent routes main last-channel telegram", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdis-gw-"));
    testSessionStorePath = path.join(dir, "sessions.json");
    await fs.writeFile(
      testSessionStorePath,
      JSON.stringify(
        {
          main: {
            sessionId: "sess-main",
            updatedAt: Date.now(),
            lastChannel: "telegram",
            lastTo: "123",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    ws.send(
      JSON.stringify({
        type: "req",
        id: "agent-last",
        method: "agent",
        params: {
          message: "hi",
          sessionKey: "main",
          channel: "last",
          deliver: true,
          idempotencyKey: "idem-agent-last",
        },
      }),
    );
    await onceMessage(ws, (o) => o.type === "res" && o.id === "agent-last");

    const spy = vi.mocked(agentCommand);
    expect(spy).toHaveBeenCalled();
    const call = spy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(call.provider).toBe("telegram");
    expect(call.to).toBe("123");
    expect(call.deliver).toBe(true);
    expect(call.bestEffortDeliver).toBe(true);
    expect(call.sessionId).toBe("sess-main");

    ws.close();
    await server.close();
  });

  test("agent routes main last-channel discord", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdis-gw-"));
    testSessionStorePath = path.join(dir, "sessions.json");
    await fs.writeFile(
      testSessionStorePath,
      JSON.stringify(
        {
          main: {
            sessionId: "sess-discord",
            updatedAt: Date.now(),
            lastChannel: "discord",
            lastTo: "channel:discord-123",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    ws.send(
      JSON.stringify({
        type: "req",
        id: "agent-last-discord",
        method: "agent",
        params: {
          message: "hi",
          sessionKey: "main",
          channel: "last",
          deliver: true,
          idempotencyKey: "idem-agent-last-discord",
        },
      }),
    );
    await onceMessage(
      ws,
      (o) => o.type === "res" && o.id === "agent-last-discord",
    );

    const spy = vi.mocked(agentCommand);
    expect(spy).toHaveBeenCalled();
    const call = spy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(call.provider).toBe("discord");
    expect(call.to).toBe("channel:discord-123");
    expect(call.deliver).toBe(true);
    expect(call.bestEffortDeliver).toBe(true);
    expect(call.sessionId).toBe("sess-discord");

    ws.close();
    await server.close();
  });

  test("agent ignores webchat last-channel for routing", async () => {
    testAllowFrom = ["+1555"];
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdis-gw-"));
    testSessionStorePath = path.join(dir, "sessions.json");
    await fs.writeFile(
      testSessionStorePath,
      JSON.stringify(
        {
          main: {
            sessionId: "sess-main-webchat",
            updatedAt: Date.now(),
            lastChannel: "webchat",
            lastTo: "+1555",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    ws.send(
      JSON.stringify({
        type: "req",
        id: "agent-webchat",
        method: "agent",
        params: {
          message: "hi",
          sessionKey: "main",
          channel: "last",
          deliver: true,
          idempotencyKey: "idem-agent-webchat",
        },
      }),
    );
    await onceMessage(ws, (o) => o.type === "res" && o.id === "agent-webchat");

    const spy = vi.mocked(agentCommand);
    expect(spy).toHaveBeenCalled();
    const call = spy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(call.provider).toBe("whatsapp");
    expect(call.to).toBe("+1555");
    expect(call.deliver).toBe(true);
    expect(call.bestEffortDeliver).toBe(true);
    expect(call.sessionId).toBe("sess-main-webchat");

    ws.close();
    await server.close();
  });

  test("hello-ok advertises the gateway port for canvas host", async () => {
    const prevToken = process.env.CLAWDIS_GATEWAY_TOKEN;
    process.env.CLAWDIS_GATEWAY_TOKEN = "secret";
    testTailnetIPv4.value = "100.64.0.1";
    testGatewayBind = "lan";

    const port = await getFreePort();
    const server = await startGatewayServer(port, {
      bind: "lan",
      allowCanvasHostInTests: true,
    });
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { Host: `100.64.0.1:${port}` },
    });
    await new Promise<void>((resolve) => ws.once("open", resolve));

    const hello = await connectOk(ws, { token: "secret" });
    expect(hello.canvasHostUrl).toBe(`http://100.64.0.1:18793`);

    ws.close();
    await server.close();
    if (prevToken === undefined) {
      delete process.env.CLAWDIS_GATEWAY_TOKEN;
    } else {
      process.env.CLAWDIS_GATEWAY_TOKEN = prevToken;
    }
  });

  test("rejects protocol mismatch", async () => {
    const { server, ws } = await startServerWithClient();
    try {
      const res = await connectReq(ws, {
        minProtocol: PROTOCOL_VERSION + 1,
        maxProtocol: PROTOCOL_VERSION + 2,
      });
      expect(res.ok).toBe(false);
    } catch {
      // If the server closed before we saw the frame, that's acceptable for mismatch.
    }
    ws.close();
    await server.close();
  });

  test("rejects invalid token", async () => {
    const { server, ws, prevToken } = await startServerWithClient("secret");
    const res = await connectReq(ws, { token: "wrong" });
    expect(res.ok).toBe(false);
    expect(res.error?.message ?? "").toContain("unauthorized");
    ws.close();
    await server.close();
    process.env.CLAWDIS_GATEWAY_TOKEN = prevToken;
  });

  test("accepts password auth when configured", async () => {
    testGatewayAuth = { mode: "password", password: "secret" };
    const port = await getFreePort();
    const server = await startGatewayServer(port);
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve) => ws.once("open", resolve));

    const res = await connectReq(ws, { password: "secret" });
    expect(res.ok).toBe(true);

    ws.close();
    await server.close();
  });

  test("rejects invalid password", async () => {
    testGatewayAuth = { mode: "password", password: "secret" };
    const port = await getFreePort();
    const server = await startGatewayServer(port);
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve) => ws.once("open", resolve));

    const res = await connectReq(ws, { password: "wrong" });
    expect(res.ok).toBe(false);
    expect(res.error?.message ?? "").toContain("unauthorized");

    ws.close();
    await server.close();
  });

  test(
    "closes silent handshakes after timeout",
    { timeout: 15_000 },
    async () => {
      const { server, ws } = await startServerWithClient();
      const closed = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 12_000);
        ws.once("close", () => {
          clearTimeout(timer);
          resolve(true);
        });
      });
      expect(closed).toBe(true);
      await server.close();
    },
  );

  test("connect (req) handshake returns hello-ok payload", async () => {
    const { server, ws } = await startServerWithClient();
    const id = randomUUID();
    ws.send(
      JSON.stringify({
        type: "req",
        id,
        method: "connect",
        params: {
          minProtocol: PROTOCOL_VERSION,
          maxProtocol: PROTOCOL_VERSION,
          client: {
            name: "test",
            version: "1.0.0",
            platform: "test",
            mode: "test",
          },
          caps: [],
        },
      }),
    );

    const res = await onceMessage<{ ok: boolean; payload?: unknown }>(
      ws,
      (o) => o.type === "res" && o.id === id,
    );
    expect(res.ok).toBe(true);
    expect((res.payload as { type?: unknown } | undefined)?.type).toBe(
      "hello-ok",
    );
    ws.close();
    await server.close();
  });

  test("rejects non-connect first request", async () => {
    const { server, ws } = await startServerWithClient();
    ws.send(JSON.stringify({ type: "req", id: "h1", method: "health" }));
    const res = await onceMessage<{ ok: boolean; error?: unknown }>(
      ws,
      (o) => o.type === "res" && o.id === "h1",
    );
    expect(res.ok).toBe(false);
    await new Promise<void>((resolve) => ws.once("close", () => resolve()));
    await server.close();
  });

  test(
    "connect + health + presence + status succeed",
    { timeout: 8000 },
    async () => {
      const { server, ws } = await startServerWithClient();
      await connectOk(ws);

      const healthP = onceMessage(
        ws,
        (o) => o.type === "res" && o.id === "health1",
      );
      const statusP = onceMessage(
        ws,
        (o) => o.type === "res" && o.id === "status1",
      );
      const presenceP = onceMessage(
        ws,
        (o) => o.type === "res" && o.id === "presence1",
      );
      const providersP = onceMessage(
        ws,
        (o) => o.type === "res" && o.id === "providers1",
      );

      const sendReq = (id: string, method: string) =>
        ws.send(JSON.stringify({ type: "req", id, method }));
      sendReq("health1", "health");
      sendReq("status1", "status");
      sendReq("presence1", "system-presence");
      sendReq("providers1", "providers.status");

      const health = await healthP;
      const status = await statusP;
      const presence = await presenceP;
      const providers = await providersP;
      expect(health.ok).toBe(true);
      expect(status.ok).toBe(true);
      expect(presence.ok).toBe(true);
      expect(providers.ok).toBe(true);
      expect(Array.isArray(presence.payload)).toBe(true);

      ws.close();
      await server.close();
    },
  );

  test("providers.status returns snapshot without probe", async () => {
    const prevToken = process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_BOT_TOKEN;
    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const res = await rpcReq<{
      whatsapp?: { linked?: boolean };
      telegram?: {
        configured?: boolean;
        tokenSource?: string;
        probe?: unknown;
        lastProbeAt?: unknown;
      };
    }>(ws, "providers.status", { probe: false, timeoutMs: 2000 });
    expect(res.ok).toBe(true);
    expect(res.payload?.whatsapp).toBeTruthy();
    expect(res.payload?.telegram?.configured).toBe(false);
    expect(res.payload?.telegram?.tokenSource).toBe("none");
    expect(res.payload?.telegram?.probe).toBeUndefined();
    expect(res.payload?.telegram?.lastProbeAt).toBeNull();

    ws.close();
    await server.close();
    if (prevToken === undefined) {
      delete process.env.TELEGRAM_BOT_TOKEN;
    } else {
      process.env.TELEGRAM_BOT_TOKEN = prevToken;
    }
  });

  test("web.logout reports no session when missing", async () => {
    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const res = await rpcReq<{ cleared?: boolean }>(ws, "web.logout");
    expect(res.ok).toBe(true);
    expect(res.payload?.cleared).toBe(false);

    ws.close();
    await server.close();
  });

  test("telegram.logout clears bot token from config", async () => {
    const prevToken = process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_BOT_TOKEN;
    await writeConfigFile({
      telegram: { botToken: "123:abc", requireMention: false },
    });

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const res = await rpcReq<{ cleared?: boolean; envToken?: boolean }>(
      ws,
      "telegram.logout",
    );
    expect(res.ok).toBe(true);
    expect(res.payload?.cleared).toBe(true);
    expect(res.payload?.envToken).toBe(false);

    const snap = await readConfigFileSnapshot();
    expect(snap.valid).toBe(true);
    expect(snap.config?.telegram?.botToken).toBeUndefined();
    expect(snap.config?.telegram?.requireMention).toBe(false);

    ws.close();
    await server.close();
    if (prevToken === undefined) {
      delete process.env.TELEGRAM_BOT_TOKEN;
    } else {
      process.env.TELEGRAM_BOT_TOKEN = prevToken;
    }
  });

  test(
    "presence events carry seq + stateVersion",
    { timeout: 8000 },
    async () => {
      const { server, ws } = await startServerWithClient();
      await connectOk(ws);

      const presenceEventP = onceMessage(
        ws,
        (o) => o.type === "event" && o.event === "presence",
      );
      ws.send(
        JSON.stringify({
          type: "req",
          id: "evt-1",
          method: "system-event",
          params: { text: "note from test" },
        }),
      );

      const evt = await presenceEventP;
      expect(typeof evt.seq).toBe("number");
      expect(evt.stateVersion?.presence).toBeGreaterThan(0);
      expect(Array.isArray(evt.payload?.presence)).toBe(true);

      ws.close();
      await server.close();
    },
  );

  test("agent events stream with seq", { timeout: 8000 }, async () => {
    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    // Emit a fake agent event directly through the shared emitter.
    const runId = randomUUID();
    const evtPromise = onceMessage(
      ws,
      (o) =>
        o.type === "event" &&
        o.event === "agent" &&
        o.payload?.runId === runId &&
        o.payload?.stream === "job",
    );
    emitAgentEvent({ runId, stream: "job", data: { msg: "hi" } });
    const evt = await evtPromise;
    expect(evt.payload.runId).toBe(runId);
    expect(typeof evt.seq).toBe("number");
    expect(evt.payload.data.msg).toBe("hi");

    ws.close();
    await server.close();
  });

  test(
    "agent ack response then final response",
    { timeout: 8000 },
    async () => {
      const { server, ws } = await startServerWithClient();
      await connectOk(ws);

      const ackP = onceMessage(
        ws,
        (o) =>
          o.type === "res" &&
          o.id === "ag1" &&
          o.payload?.status === "accepted",
      );
      const finalP = onceMessage(
        ws,
        (o) =>
          o.type === "res" &&
          o.id === "ag1" &&
          o.payload?.status !== "accepted",
      );
      ws.send(
        JSON.stringify({
          type: "req",
          id: "ag1",
          method: "agent",
          params: { message: "hi", idempotencyKey: "idem-ag" },
        }),
      );

      const ack = await ackP;
      const final = await finalP;
      expect(ack.payload.runId).toBeDefined();
      expect(final.payload.runId).toBe(ack.payload.runId);
      expect(final.payload.status).toBe("ok");

      ws.close();
      await server.close();
    },
  );

  test(
    "agent dedupes by idempotencyKey after completion",
    { timeout: 8000 },
    async () => {
      const { server, ws } = await startServerWithClient();
      await connectOk(ws);

      const firstFinalP = onceMessage(
        ws,
        (o) =>
          o.type === "res" &&
          o.id === "ag1" &&
          o.payload?.status !== "accepted",
      );
      ws.send(
        JSON.stringify({
          type: "req",
          id: "ag1",
          method: "agent",
          params: { message: "hi", idempotencyKey: "same-agent" },
        }),
      );
      const firstFinal = await firstFinalP;

      const secondP = onceMessage(
        ws,
        (o) => o.type === "res" && o.id === "ag2",
      );
      ws.send(
        JSON.stringify({
          type: "req",
          id: "ag2",
          method: "agent",
          params: { message: "hi again", idempotencyKey: "same-agent" },
        }),
      );
      const second = await secondP;
      expect(second.payload).toEqual(firstFinal.payload);

      ws.close();
      await server.close();
    },
  );

  test("shutdown event is broadcast on close", { timeout: 8000 }, async () => {
    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const shutdownP = onceMessage(
      ws,
      (o) => o.type === "event" && o.event === "shutdown",
      5000,
    );
    await server.close();
    const evt = await shutdownP;
    expect(evt.payload?.reason).toBeDefined();
  });

  test(
    "presence broadcast reaches multiple clients",
    { timeout: 8000 },
    async () => {
      const port = await getFreePort();
      const server = await startGatewayServer(port);
      const mkClient = async () => {
        const c = new WebSocket(`ws://127.0.0.1:${port}`);
        await new Promise<void>((resolve) => c.once("open", resolve));
        await connectOk(c);
        return c;
      };

      const clients = await Promise.all([mkClient(), mkClient(), mkClient()]);
      const waits = clients.map((c) =>
        onceMessage(c, (o) => o.type === "event" && o.event === "presence"),
      );
      clients[0].send(
        JSON.stringify({
          type: "req",
          id: "broadcast",
          method: "system-event",
          params: { text: "fanout" },
        }),
      );
      const events = await Promise.all(waits);
      for (const evt of events) {
        expect(evt.payload?.presence?.length).toBeGreaterThan(0);
        expect(typeof evt.seq).toBe("number");
      }
      for (const c of clients) c.close();
      await server.close();
    },
  );

  test("send dedupes by idempotencyKey", { timeout: 8000 }, async () => {
    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const idem = "same-key";
    const res1P = onceMessage(ws, (o) => o.type === "res" && o.id === "a1");
    const res2P = onceMessage(ws, (o) => o.type === "res" && o.id === "a2");
    const sendReq = (id: string) =>
      ws.send(
        JSON.stringify({
          type: "req",
          id,
          method: "send",
          params: { to: "+15550000000", message: "hi", idempotencyKey: idem },
        }),
      );
    sendReq("a1");
    sendReq("a2");

    const res1 = await res1P;
    const res2 = await res2P;
    expect(res1.ok).toBe(true);
    expect(res2.ok).toBe(true);
    expect(res1.payload).toEqual(res2.payload);
    ws.close();
    await server.close();
  });

  test("agent dedupe survives reconnect", { timeout: 15000 }, async () => {
    const port = await getFreePort();
    const server = await startGatewayServer(port);

    const dial = async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      await new Promise<void>((resolve) => ws.once("open", resolve));
      await connectOk(ws);
      return ws;
    };

    const idem = "reconnect-agent";
    const ws1 = await dial();
    const final1P = onceMessage(
      ws1,
      (o) =>
        o.type === "res" && o.id === "ag1" && o.payload?.status !== "accepted",
      6000,
    );
    ws1.send(
      JSON.stringify({
        type: "req",
        id: "ag1",
        method: "agent",
        params: { message: "hi", idempotencyKey: idem },
      }),
    );
    const final1 = await final1P;
    ws1.close();

    const ws2 = await dial();
    const final2P = onceMessage(
      ws2,
      (o) =>
        o.type === "res" && o.id === "ag2" && o.payload?.status !== "accepted",
      6000,
    );
    ws2.send(
      JSON.stringify({
        type: "req",
        id: "ag2",
        method: "agent",
        params: { message: "hi again", idempotencyKey: idem },
      }),
    );
    const res = await final2P;
    expect(res.payload).toEqual(final1.payload);
    ws2.close();
    await server.close();
  });

  test("chat.send accepts image attachment", { timeout: 12000 }, async () => {
    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const reqId = "chat-img";
    ws.send(
      JSON.stringify({
        type: "req",
        id: reqId,
        method: "chat.send",
        params: {
          sessionKey: "main",
          message: "see image",
          idempotencyKey: "idem-img",
          attachments: [
            {
              type: "image",
              mimeType: "image/png",
              fileName: "dot.png",
              content:
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=",
            },
          ],
        },
      }),
    );

    const res = await onceMessage(
      ws,
      (o) => o.type === "res" && o.id === reqId,
      8000,
    );
    expect(res.ok).toBe(true);
    expect(res.payload?.runId).toBeDefined();

    ws.close();
    await server.close();
  });

  test("chat.history caps large histories and honors limit", async () => {
    const firstContentText = (msg: unknown): string | undefined => {
      if (!msg || typeof msg !== "object") return undefined;
      const content = (msg as { content?: unknown }).content;
      if (!Array.isArray(content) || content.length === 0) return undefined;
      const first = content[0];
      if (!first || typeof first !== "object") return undefined;
      const text = (first as { text?: unknown }).text;
      return typeof text === "string" ? text : undefined;
    };

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdis-gw-"));
    testSessionStorePath = path.join(dir, "sessions.json");
    await fs.writeFile(
      testSessionStorePath,
      JSON.stringify(
        {
          main: {
            sessionId: "sess-main",
            updatedAt: Date.now(),
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const lines: string[] = [];
    for (let i = 0; i < 300; i += 1) {
      lines.push(
        JSON.stringify({
          message: {
            role: "user",
            content: [{ type: "text", text: `m${i}` }],
            timestamp: Date.now() + i,
          },
        }),
      );
    }
    await fs.writeFile(
      path.join(dir, "sess-main.jsonl"),
      lines.join("\n"),
      "utf-8",
    );

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const defaultRes = await rpcReq<{ messages?: unknown[] }>(
      ws,
      "chat.history",
      {
        sessionKey: "main",
      },
    );
    expect(defaultRes.ok).toBe(true);
    const defaultMsgs = defaultRes.payload?.messages ?? [];
    expect(defaultMsgs.length).toBe(200);
    expect(firstContentText(defaultMsgs[0])).toBe("m100");

    const limitedRes = await rpcReq<{ messages?: unknown[] }>(
      ws,
      "chat.history",
      {
        sessionKey: "main",
        limit: 5,
      },
    );
    expect(limitedRes.ok).toBe(true);
    const limitedMsgs = limitedRes.payload?.messages ?? [];
    expect(limitedMsgs.length).toBe(5);
    expect(firstContentText(limitedMsgs[0])).toBe("m295");

    const largeLines: string[] = [];
    for (let i = 0; i < 1500; i += 1) {
      largeLines.push(
        JSON.stringify({
          message: {
            role: "user",
            content: [{ type: "text", text: `b${i}` }],
            timestamp: Date.now() + i,
          },
        }),
      );
    }
    await fs.writeFile(
      path.join(dir, "sess-main.jsonl"),
      largeLines.join("\n"),
      "utf-8",
    );

    const cappedRes = await rpcReq<{ messages?: unknown[] }>(
      ws,
      "chat.history",
      {
        sessionKey: "main",
      },
    );
    expect(cappedRes.ok).toBe(true);
    const cappedMsgs = cappedRes.payload?.messages ?? [];
    expect(cappedMsgs.length).toBe(200);
    expect(firstContentText(cappedMsgs[0])).toBe("b1300");

    const maxRes = await rpcReq<{ messages?: unknown[] }>(ws, "chat.history", {
      sessionKey: "main",
      limit: 1000,
    });
    expect(maxRes.ok).toBe(true);
    const maxMsgs = maxRes.payload?.messages ?? [];
    expect(maxMsgs.length).toBe(1000);
    expect(firstContentText(maxMsgs[0])).toBe("b500");

    ws.close();
    await server.close();
  });

  test("chat.history caps payload bytes", { timeout: 15_000 }, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdis-gw-"));
    testSessionStorePath = path.join(dir, "sessions.json");
    await fs.writeFile(
      testSessionStorePath,
      JSON.stringify(
        {
          main: {
            sessionId: "sess-main",
            updatedAt: Date.now(),
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const bigText = "x".repeat(200_000);
    const largeLines: string[] = [];
    for (let i = 0; i < 40; i += 1) {
      largeLines.push(
        JSON.stringify({
          message: {
            role: "user",
            content: [{ type: "text", text: `${i}:${bigText}` }],
            timestamp: Date.now() + i,
          },
        }),
      );
    }
    await fs.writeFile(
      path.join(dir, "sess-main.jsonl"),
      largeLines.join("\n"),
      "utf-8",
    );

    const cappedRes = await rpcReq<{ messages?: unknown[] }>(
      ws,
      "chat.history",
      { sessionKey: "main", limit: 1000 },
    );
    expect(cappedRes.ok).toBe(true);
    const cappedMsgs = cappedRes.payload?.messages ?? [];
    const bytes = Buffer.byteLength(JSON.stringify(cappedMsgs), "utf8");
    expect(bytes).toBeLessThanOrEqual(6 * 1024 * 1024);
    expect(cappedMsgs.length).toBeLessThan(60);

    ws.close();
    await server.close();
  });

  test("chat.send does not overwrite last delivery route", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdis-gw-"));
    testSessionStorePath = path.join(dir, "sessions.json");
    await fs.writeFile(
      testSessionStorePath,
      JSON.stringify(
        {
          main: {
            sessionId: "sess-main",
            updatedAt: Date.now(),
            lastChannel: "whatsapp",
            lastTo: "+1555",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const reqId = "chat-route";
    ws.send(
      JSON.stringify({
        type: "req",
        id: reqId,
        method: "chat.send",
        params: {
          sessionKey: "main",
          message: "hello",
          idempotencyKey: "idem-route",
        },
      }),
    );

    const res = await onceMessage(
      ws,
      (o) => o.type === "res" && o.id === reqId,
    );
    expect(res.ok).toBe(true);

    const stored = JSON.parse(
      await fs.readFile(testSessionStorePath, "utf-8"),
    ) as {
      main?: { lastChannel?: string; lastTo?: string };
    };
    expect(stored.main?.lastChannel).toBe("whatsapp");
    expect(stored.main?.lastTo).toBe("+1555");

    ws.close();
    await server.close();
  });

  test(
    "chat.abort cancels an in-flight chat.send",
    { timeout: 15000 },
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdis-gw-"));
      testSessionStorePath = path.join(dir, "sessions.json");
      await fs.writeFile(
        testSessionStorePath,
        JSON.stringify(
          {
            main: {
              sessionId: "sess-main",
              updatedAt: Date.now(),
            },
          },
          null,
          2,
        ),
        "utf-8",
      );

      const { server, ws } = await startServerWithClient();
      let inFlight: Promise<unknown> | undefined;
      try {
        await connectOk(ws);

        const spy = vi.mocked(agentCommand);
        const callsBefore = spy.mock.calls.length;
        spy.mockImplementationOnce(async (opts) => {
          const signal = (opts as { abortSignal?: AbortSignal }).abortSignal;
          await new Promise<void>((resolve) => {
            if (!signal) return resolve();
            if (signal.aborted) return resolve();
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        });

        const sendResP = onceMessage(
          ws,
          (o) => o.type === "res" && o.id === "send-abort-1",
          8000,
        );
        const abortResP = onceMessage(
          ws,
          (o) => o.type === "res" && o.id === "abort-1",
          8000,
        );
        const abortedEventP = onceMessage(
          ws,
          (o) =>
            o.type === "event" &&
            o.event === "chat" &&
            o.payload?.state === "aborted",
          8000,
        );
        inFlight = Promise.allSettled([sendResP, abortResP, abortedEventP]);

        ws.send(
          JSON.stringify({
            type: "req",
            id: "send-abort-1",
            method: "chat.send",
            params: {
              sessionKey: "main",
              message: "hello",
              idempotencyKey: "idem-abort-1",
              timeoutMs: 30_000,
            },
          }),
        );

        await new Promise<void>((resolve, reject) => {
          const deadline = Date.now() + 1000;
          const tick = () => {
            if (spy.mock.calls.length > callsBefore) return resolve();
            if (Date.now() > deadline)
              return reject(new Error("timeout waiting for agentCommand"));
            setTimeout(tick, 5);
          };
          tick();
        });

        ws.send(
          JSON.stringify({
            type: "req",
            id: "abort-1",
            method: "chat.abort",
            params: { sessionKey: "main", runId: "idem-abort-1" },
          }),
        );

        const abortRes = await abortResP;
        expect(abortRes.ok).toBe(true);

        const sendRes = await sendResP;
        expect(sendRes.ok).toBe(true);

        const evt = await abortedEventP;
        expect(evt.payload?.runId).toBe("idem-abort-1");
        expect(evt.payload?.sessionKey).toBe("main");
      } finally {
        ws.close();
        await inFlight;
        await server.close();
      }
    },
  );

  test("chat.abort cancels while saving the session store", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdis-gw-"));
    testSessionStorePath = path.join(dir, "sessions.json");
    await fs.writeFile(
      testSessionStorePath,
      JSON.stringify(
        {
          main: {
            sessionId: "sess-main",
            updatedAt: Date.now(),
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    sessionStoreSaveDelayMs.value = 120;

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const spy = vi.mocked(agentCommand);
    spy.mockImplementationOnce(async (opts) => {
      const signal = (opts as { abortSignal?: AbortSignal }).abortSignal;
      await new Promise<void>((resolve) => {
        if (!signal) return resolve();
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    });

    const abortedEventP = onceMessage(
      ws,
      (o) =>
        o.type === "event" &&
        o.event === "chat" &&
        o.payload?.state === "aborted",
    );

    const sendResP = onceMessage(
      ws,
      (o) => o.type === "res" && o.id === "send-abort-save-1",
    );

    ws.send(
      JSON.stringify({
        type: "req",
        id: "send-abort-save-1",
        method: "chat.send",
        params: {
          sessionKey: "main",
          message: "hello",
          idempotencyKey: "idem-abort-save-1",
          timeoutMs: 30_000,
        },
      }),
    );

    const abortResP = onceMessage(
      ws,
      (o) => o.type === "res" && o.id === "abort-save-1",
    );
    ws.send(
      JSON.stringify({
        type: "req",
        id: "abort-save-1",
        method: "chat.abort",
        params: { sessionKey: "main", runId: "idem-abort-save-1" },
      }),
    );

    const abortRes = await abortResP;
    expect(abortRes.ok).toBe(true);

    const sendRes = await sendResP;
    expect(sendRes.ok).toBe(true);

    const evt = await abortedEventP;
    expect(evt.payload?.runId).toBe("idem-abort-save-1");
    expect(evt.payload?.sessionKey).toBe("main");

    ws.close();
    await server.close();
  });

  test("chat.abort returns aborted=false for unknown runId", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdis-gw-"));
    testSessionStorePath = path.join(dir, "sessions.json");
    await fs.writeFile(
      testSessionStorePath,
      JSON.stringify({}, null, 2),
      "utf-8",
    );

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    ws.send(
      JSON.stringify({
        type: "req",
        id: "abort-unknown-1",
        method: "chat.abort",
        params: { sessionKey: "main", runId: "missing-run" },
      }),
    );

    const abortRes = await onceMessage<{
      type: "res";
      id: string;
      ok: boolean;
      payload?: { ok?: boolean; aborted?: boolean };
    }>(ws, (o) => o.type === "res" && o.id === "abort-unknown-1");

    expect(abortRes.ok).toBe(true);
    expect(abortRes.payload?.aborted).toBe(false);

    ws.close();
    await server.close();
  });

  test("chat.abort rejects mismatched sessionKey", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdis-gw-"));
    testSessionStorePath = path.join(dir, "sessions.json");
    await fs.writeFile(
      testSessionStorePath,
      JSON.stringify(
        {
          main: {
            sessionId: "sess-main",
            updatedAt: Date.now(),
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const spy = vi.mocked(agentCommand);
    let agentStartedResolve: (() => void) | undefined;
    const agentStartedP = new Promise<void>((resolve) => {
      agentStartedResolve = resolve;
    });
    spy.mockImplementationOnce(async (opts) => {
      agentStartedResolve?.();
      const signal = (opts as { abortSignal?: AbortSignal }).abortSignal;
      await new Promise<void>((resolve) => {
        if (!signal) return resolve();
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    });

    const sendResP = onceMessage(
      ws,
      (o) => o.type === "res" && o.id === "send-mismatch-1",
      10_000,
    );
    ws.send(
      JSON.stringify({
        type: "req",
        id: "send-mismatch-1",
        method: "chat.send",
        params: {
          sessionKey: "main",
          message: "hello",
          idempotencyKey: "idem-mismatch-1",
          timeoutMs: 30_000,
        },
      }),
    );

    await agentStartedP;

    const abortResP = onceMessage(
      ws,
      (o) => o.type === "res" && o.id === "abort-mismatch-1",
      10_000,
    );
    ws.send(
      JSON.stringify({
        type: "req",
        id: "abort-mismatch-1",
        method: "chat.abort",
        params: { sessionKey: "other", runId: "idem-mismatch-1" },
      }),
    );

    const abortRes = await abortResP;
    expect(abortRes.ok).toBe(false);
    expect(abortRes.error?.code).toBe("INVALID_REQUEST");

    const abortRes2P = onceMessage(
      ws,
      (o) => o.type === "res" && o.id === "abort-mismatch-2",
      10_000,
    );
    ws.send(
      JSON.stringify({
        type: "req",
        id: "abort-mismatch-2",
        method: "chat.abort",
        params: { sessionKey: "main", runId: "idem-mismatch-1" },
      }),
    );

    const abortRes2 = await abortRes2P;
    expect(abortRes2.ok).toBe(true);

    const sendRes = await sendResP;
    expect(sendRes.ok).toBe(true);

    ws.close();
    await server.close();
  }, 15_000);

  test("chat.abort is a no-op after chat.send completes", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdis-gw-"));
    testSessionStorePath = path.join(dir, "sessions.json");
    await fs.writeFile(
      testSessionStorePath,
      JSON.stringify(
        {
          main: {
            sessionId: "sess-main",
            updatedAt: Date.now(),
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const spy = vi.mocked(agentCommand);
    spy.mockResolvedValueOnce(undefined);

    ws.send(
      JSON.stringify({
        type: "req",
        id: "send-complete-1",
        method: "chat.send",
        params: {
          sessionKey: "main",
          message: "hello",
          idempotencyKey: "idem-complete-1",
          timeoutMs: 30_000,
        },
      }),
    );

    const sendRes = await onceMessage(
      ws,
      (o) => o.type === "res" && o.id === "send-complete-1",
    );
    expect(sendRes.ok).toBe(true);

    ws.send(
      JSON.stringify({
        type: "req",
        id: "abort-complete-1",
        method: "chat.abort",
        params: { sessionKey: "main", runId: "idem-complete-1" },
      }),
    );

    const abortRes = await onceMessage(
      ws,
      (o) => o.type === "res" && o.id === "abort-complete-1",
    );
    expect(abortRes.ok).toBe(true);
    expect(abortRes.payload?.aborted).toBe(false);

    ws.close();
    await server.close();
  });

  test("bridge RPC chat.history returns session messages", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdis-gw-"));
    testSessionStorePath = path.join(dir, "sessions.json");
    await fs.writeFile(
      testSessionStorePath,
      JSON.stringify(
        {
          main: {
            sessionId: "sess-main",
            updatedAt: Date.now(),
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    await fs.writeFile(
      path.join(dir, "sess-main.jsonl"),
      [
        JSON.stringify({
          message: {
            role: "user",
            content: [{ type: "text", text: "hi" }],
            timestamp: Date.now(),
          },
        }),
      ].join("\n"),
      "utf-8",
    );

    const port = await getFreePort();
    const server = await startGatewayServer(port);
    const bridgeCall = bridgeStartCalls.at(-1);
    expect(bridgeCall?.onRequest).toBeDefined();

    const res = await bridgeCall?.onRequest?.("ios-node", {
      id: "r1",
      method: "chat.history",
      paramsJSON: JSON.stringify({ sessionKey: "main" }),
    });

    expect(res?.ok).toBe(true);
    const payload = JSON.parse(
      String((res as { payloadJSON?: string }).payloadJSON ?? "{}"),
    ) as {
      sessionKey?: string;
      sessionId?: string;
      messages?: unknown[];
    };
    expect(payload.sessionKey).toBe("main");
    expect(payload.sessionId).toBe("sess-main");
    expect(Array.isArray(payload.messages)).toBe(true);
    expect(payload.messages?.length).toBeGreaterThan(0);

    await server.close();
  });

  test("bridge RPC sessions.list returns session rows", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdis-gw-"));
    testSessionStorePath = path.join(dir, "sessions.json");
    await fs.writeFile(
      testSessionStorePath,
      JSON.stringify(
        {
          main: {
            sessionId: "sess-main",
            updatedAt: Date.now(),
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const port = await getFreePort();
    const server = await startGatewayServer(port);
    const bridgeCall = bridgeStartCalls.at(-1);
    expect(bridgeCall?.onRequest).toBeDefined();

    const res = await bridgeCall?.onRequest?.("ios-node", {
      id: "r1",
      method: "sessions.list",
      paramsJSON: JSON.stringify({
        includeGlobal: true,
        includeUnknown: false,
        limit: 50,
      }),
    });

    expect(res?.ok).toBe(true);
    const payload = JSON.parse(
      String((res as { payloadJSON?: string }).payloadJSON ?? "{}"),
    ) as {
      sessions?: unknown[];
      count?: number;
      path?: string;
    };
    expect(Array.isArray(payload.sessions)).toBe(true);
    expect(typeof payload.count).toBe("number");
    expect(typeof payload.path).toBe("string");

    await server.close();
  });

  test("bridge chat events are pushed to subscribed nodes", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdis-gw-"));
    testSessionStorePath = path.join(dir, "sessions.json");
    await fs.writeFile(
      testSessionStorePath,
      JSON.stringify(
        {
          main: {
            sessionId: "sess-main",
            updatedAt: Date.now(),
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const port = await getFreePort();
    const server = await startGatewayServer(port);
    const bridgeCall = bridgeStartCalls.at(-1);
    expect(bridgeCall?.onEvent).toBeDefined();
    expect(bridgeCall?.onRequest).toBeDefined();

    // Subscribe the node to chat events for main.
    await bridgeCall?.onEvent?.("ios-node", {
      event: "chat.subscribe",
      payloadJSON: JSON.stringify({ sessionKey: "main" }),
    });

    bridgeSendEvent.mockClear();

    // Trigger a chat.send, then simulate agent bus completion for the sessionId.
    const reqRes = await bridgeCall?.onRequest?.("ios-node", {
      id: "s1",
      method: "chat.send",
      paramsJSON: JSON.stringify({
        sessionKey: "main",
        message: "hello",
        idempotencyKey: "idem-bridge-chat",
        timeoutMs: 30_000,
      }),
    });
    expect(reqRes?.ok).toBe(true);

    emitAgentEvent({
      runId: "sess-main",
      seq: 1,
      ts: Date.now(),
      stream: "assistant",
      data: { text: "hi from agent" },
    });
    emitAgentEvent({
      runId: "sess-main",
      seq: 2,
      ts: Date.now(),
      stream: "job",
      data: { state: "done" },
    });

    // Wait a tick for the bridge send to happen.
    await new Promise((r) => setTimeout(r, 25));

    expect(bridgeSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: "ios-node",
        event: "agent",
      }),
    );

    expect(bridgeSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: "ios-node",
        event: "chat",
      }),
    );

    await server.close();
  });

  test("bridge voice transcript defaults to main session", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdis-gw-"));
    testSessionStorePath = path.join(dir, "sessions.json");
    await fs.writeFile(
      testSessionStorePath,
      JSON.stringify(
        {
          main: {
            sessionId: "sess-main",
            updatedAt: Date.now(),
            lastChannel: "whatsapp",
            lastTo: "+1555",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const port = await getFreePort();
    const server = await startGatewayServer(port);
    const bridgeCall = bridgeStartCalls.at(-1);
    expect(bridgeCall?.onEvent).toBeDefined();

    const spy = vi.mocked(agentCommand);
    const beforeCalls = spy.mock.calls.length;

    await bridgeCall?.onEvent?.("ios-node", {
      event: "voice.transcript",
      payloadJSON: JSON.stringify({ text: "hello" }),
    });

    expect(spy.mock.calls.length).toBe(beforeCalls + 1);
    const call = spy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(call.sessionId).toBe("sess-main");
    expect(call.deliver).toBe(false);
    expect(call.surface).toBe("Node");

    const stored = JSON.parse(
      await fs.readFile(testSessionStorePath, "utf-8"),
    ) as Record<string, { sessionId?: string } | undefined>;
    expect(stored.main?.sessionId).toBe("sess-main");
    expect(stored["node-ios-node"]).toBeUndefined();

    await server.close();
  });

  test("bridge chat.abort cancels while saving the session store", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdis-gw-"));
    testSessionStorePath = path.join(dir, "sessions.json");
    await fs.writeFile(
      testSessionStorePath,
      JSON.stringify(
        {
          main: {
            sessionId: "sess-main",
            updatedAt: Date.now(),
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    sessionStoreSaveDelayMs.value = 120;

    const port = await getFreePort();
    const server = await startGatewayServer(port);
    const bridgeCall = bridgeStartCalls.at(-1);
    expect(bridgeCall?.onRequest).toBeDefined();

    const spy = vi.mocked(agentCommand);
    spy.mockImplementationOnce(async (opts) => {
      const signal = (opts as { abortSignal?: AbortSignal }).abortSignal;
      await new Promise<void>((resolve) => {
        if (!signal) return resolve();
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    });

    const sendP = bridgeCall?.onRequest?.("ios-node", {
      id: "send-abort-save-bridge-1",
      method: "chat.send",
      paramsJSON: JSON.stringify({
        sessionKey: "main",
        message: "hello",
        idempotencyKey: "idem-abort-save-bridge-1",
        timeoutMs: 30_000,
      }),
    });

    const abortRes = await bridgeCall?.onRequest?.("ios-node", {
      id: "abort-save-bridge-1",
      method: "chat.abort",
      paramsJSON: JSON.stringify({
        sessionKey: "main",
        runId: "idem-abort-save-bridge-1",
      }),
    });

    expect(abortRes?.ok).toBe(true);

    const sendRes = await sendP;
    expect(sendRes?.ok).toBe(true);

    await server.close();
  });

  test("presence includes client fingerprint", async () => {
    const { server, ws } = await startServerWithClient();
    await connectOk(ws, {
      client: {
        name: "fingerprint",
        version: "9.9.9",
        platform: "test",
        deviceFamily: "iPad",
        modelIdentifier: "iPad16,6",
        mode: "ui",
        instanceId: "abc",
      },
    });

    const presenceP = onceMessage(
      ws,
      (o) => o.type === "res" && o.id === "fingerprint",
      4000,
    );
    ws.send(
      JSON.stringify({
        type: "req",
        id: "fingerprint",
        method: "system-presence",
      }),
    );

    const presenceRes = await presenceP;
    const entries = presenceRes.payload as Array<Record<string, unknown>>;
    const clientEntry = entries.find((e) => e.instanceId === "abc");
    expect(clientEntry?.host).toBe("fingerprint");
    expect(clientEntry?.version).toBe("9.9.9");
    expect(clientEntry?.mode).toBe("ui");
    expect(clientEntry?.deviceFamily).toBe("iPad");
    expect(clientEntry?.modelIdentifier).toBe("iPad16,6");

    ws.close();
    await server.close();
  });

  test("cli connections are not tracked as instances", async () => {
    const { server, ws } = await startServerWithClient();
    const cliId = `cli-${randomUUID()}`;
    await connectOk(ws, {
      client: {
        name: "cli",
        version: "dev",
        platform: "test",
        mode: "cli",
        instanceId: cliId,
      },
    });

    const presenceP = onceMessage(
      ws,
      (o) => o.type === "res" && o.id === "cli-presence",
      4000,
    );
    ws.send(
      JSON.stringify({
        type: "req",
        id: "cli-presence",
        method: "system-presence",
      }),
    );

    const presenceRes = await presenceP;
    const entries = presenceRes.payload as Array<Record<string, unknown>>;
    expect(entries.some((e) => e.instanceId === cliId)).toBe(false);

    ws.close();
    await server.close();
  });

  test("lists and patches session store via sessions.* RPC", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdis-sessions-"));
    const storePath = path.join(dir, "sessions.json");
    const now = Date.now();
    testSessionStorePath = storePath;

    await fs.writeFile(
      path.join(dir, "sess-main.jsonl"),
      `${Array.from({ length: 10 })
        .map((_, idx) =>
          JSON.stringify({ role: "user", content: `line ${idx}` }),
        )
        .join("\n")}\n`,
      "utf-8",
    );
    await fs.writeFile(
      path.join(dir, "sess-group.jsonl"),
      `${JSON.stringify({ role: "user", content: "group line 0" })}\n`,
      "utf-8",
    );

    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          main: {
            sessionId: "sess-main",
            updatedAt: now - 30_000,
            inputTokens: 10,
            outputTokens: 20,
            thinkingLevel: "low",
            verboseLevel: "on",
          },
          "group:dev": {
            sessionId: "sess-group",
            updatedAt: now - 120_000,
            totalTokens: 50,
          },
          global: {
            sessionId: "sess-global",
            updatedAt: now - 10_000,
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const { server, ws } = await startServerWithClient();
    const hello = await connectOk(ws);
    expect(
      (hello as unknown as { features?: { methods?: string[] } }).features
        ?.methods,
    ).toEqual(
      expect.arrayContaining([
        "sessions.list",
        "sessions.patch",
        "sessions.reset",
        "sessions.delete",
        "sessions.compact",
      ]),
    );

    const list1 = await rpcReq<{
      path: string;
      sessions: Array<{
        key: string;
        totalTokens?: number;
        thinkingLevel?: string;
        verboseLevel?: string;
      }>;
    }>(ws, "sessions.list", { includeGlobal: false, includeUnknown: false });

    expect(list1.ok).toBe(true);
    expect(list1.payload?.path).toBe(storePath);
    expect(list1.payload?.sessions.some((s) => s.key === "global")).toBe(false);
    const main = list1.payload?.sessions.find((s) => s.key === "main");
    expect(main?.totalTokens).toBe(30);
    expect(main?.thinkingLevel).toBe("low");
    expect(main?.verboseLevel).toBe("on");

    const active = await rpcReq<{
      sessions: Array<{ key: string }>;
    }>(ws, "sessions.list", {
      includeGlobal: false,
      includeUnknown: false,
      activeMinutes: 1,
    });
    expect(active.ok).toBe(true);
    expect(active.payload?.sessions.map((s) => s.key)).toEqual(["main"]);

    const limited = await rpcReq<{
      sessions: Array<{ key: string }>;
    }>(ws, "sessions.list", {
      includeGlobal: true,
      includeUnknown: false,
      limit: 1,
    });
    expect(limited.ok).toBe(true);
    expect(limited.payload?.sessions).toHaveLength(1);
    expect(limited.payload?.sessions[0]?.key).toBe("global");

    const patched = await rpcReq<{ ok: true; key: string }>(
      ws,
      "sessions.patch",
      { key: "main", thinkingLevel: "medium", verboseLevel: null },
    );
    expect(patched.ok).toBe(true);
    expect(patched.payload?.ok).toBe(true);
    expect(patched.payload?.key).toBe("main");

    const list2 = await rpcReq<{
      sessions: Array<{
        key: string;
        thinkingLevel?: string;
        verboseLevel?: string;
      }>;
    }>(ws, "sessions.list", {});
    expect(list2.ok).toBe(true);
    const main2 = list2.payload?.sessions.find((s) => s.key === "main");
    expect(main2?.thinkingLevel).toBe("medium");
    expect(main2?.verboseLevel).toBeUndefined();

    const compacted = await rpcReq<{ ok: true; compacted: boolean }>(
      ws,
      "sessions.compact",
      { key: "main", maxLines: 3 },
    );
    expect(compacted.ok).toBe(true);
    expect(compacted.payload?.compacted).toBe(true);
    const compactedLines = (
      await fs.readFile(path.join(dir, "sess-main.jsonl"), "utf-8")
    )
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0);
    expect(compactedLines).toHaveLength(3);
    const filesAfterCompact = await fs.readdir(dir);
    expect(
      filesAfterCompact.some((f) => f.startsWith("sess-main.jsonl.bak.")),
    ).toBe(true);

    const deleted = await rpcReq<{ ok: true; deleted: boolean }>(
      ws,
      "sessions.delete",
      { key: "group:dev" },
    );
    expect(deleted.ok).toBe(true);
    expect(deleted.payload?.deleted).toBe(true);
    const listAfterDelete = await rpcReq<{
      sessions: Array<{ key: string }>;
    }>(ws, "sessions.list", {});
    expect(listAfterDelete.ok).toBe(true);
    expect(
      listAfterDelete.payload?.sessions.some((s) => s.key === "group:dev"),
    ).toBe(false);
    const filesAfterDelete = await fs.readdir(dir);
    expect(
      filesAfterDelete.some((f) => f.startsWith("sess-group.jsonl.deleted.")),
    ).toBe(true);

    const reset = await rpcReq<{
      ok: true;
      key: string;
      entry: { sessionId: string };
    }>(ws, "sessions.reset", { key: "main" });
    expect(reset.ok).toBe(true);
    expect(reset.payload?.key).toBe("main");
    expect(reset.payload?.entry.sessionId).not.toBe("sess-main");

    const badThinking = await rpcReq(ws, "sessions.patch", {
      key: "main",
      thinkingLevel: "banana",
    });
    expect(badThinking.ok).toBe(false);
    expect(
      (badThinking.error as { message?: unknown } | undefined)?.message ?? "",
    ).toMatch(/invalid thinkinglevel/i);

    ws.close();
    await server.close();
  });

  test("refuses to start when port already bound", async () => {
    const { server: blocker, port } = await occupyPort();
    await expect(startGatewayServer(port)).rejects.toBeInstanceOf(
      GatewayLockError,
    );
    await expect(startGatewayServer(port)).rejects.toThrow(
      /already listening/i,
    );
    blocker.close();
  });

  test("releases port after close", async () => {
    const port = await getFreePort();
    const server = await startGatewayServer(port);
    await server.close();

    // If the port was released, another listener can bind immediately.
    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(port, "127.0.0.1", () => resolve());
    });
    await new Promise<void>((resolve, reject) =>
      probe.close((err) => (err ? reject(err) : resolve())),
    );
  });

  test("hooks wake requires auth", async () => {
    testHooksConfig = { enabled: true, token: "hook-secret" };
    const port = await getFreePort();
    const server = await startGatewayServer(port);
    const res = await fetch(`http://127.0.0.1:${port}/hooks/wake`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Ping" }),
    });
    expect(res.status).toBe(401);
    await server.close();
  });

  test("hooks wake enqueues system event", async () => {
    testHooksConfig = { enabled: true, token: "hook-secret" };
    const port = await getFreePort();
    const server = await startGatewayServer(port);
    const res = await fetch(`http://127.0.0.1:${port}/hooks/wake`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer hook-secret",
      },
      body: JSON.stringify({ text: "Ping", mode: "next-heartbeat" }),
    });
    expect(res.status).toBe(200);
    const events = await waitForSystemEvent();
    expect(events.some((e) => e.includes("Ping"))).toBe(true);
    drainSystemEvents();
    await server.close();
  });

  test("hooks agent posts summary to main", async () => {
    testHooksConfig = { enabled: true, token: "hook-secret" };
    cronIsolatedRun.mockResolvedValueOnce({
      status: "ok",
      summary: "done",
    });
    const port = await getFreePort();
    const server = await startGatewayServer(port);
    const res = await fetch(`http://127.0.0.1:${port}/hooks/agent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer hook-secret",
      },
      body: JSON.stringify({ message: "Do it", name: "Email" }),
    });
    expect(res.status).toBe(202);
    const events = await waitForSystemEvent();
    expect(events.some((e) => e.includes("Hook Email: done"))).toBe(true);
    drainSystemEvents();
    await server.close();
  });

  test("hooks wake accepts query token", async () => {
    testHooksConfig = { enabled: true, token: "hook-secret" };
    const port = await getFreePort();
    const server = await startGatewayServer(port);
    const res = await fetch(
      `http://127.0.0.1:${port}/hooks/wake?token=hook-secret`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Query auth" }),
      },
    );
    expect(res.status).toBe(200);
    const events = await waitForSystemEvent();
    expect(events.some((e) => e.includes("Query auth"))).toBe(true);
    drainSystemEvents();
    await server.close();
  });

  test("hooks agent rejects invalid channel", async () => {
    testHooksConfig = { enabled: true, token: "hook-secret" };
    const port = await getFreePort();
    const server = await startGatewayServer(port);
    const res = await fetch(`http://127.0.0.1:${port}/hooks/agent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer hook-secret",
      },
      body: JSON.stringify({ message: "Nope", channel: "sms" }),
    });
    expect(res.status).toBe(400);
    expect(peekSystemEvents().length).toBe(0);
    await server.close();
  });

  test("hooks wake accepts x-clawdis-token header", async () => {
    testHooksConfig = { enabled: true, token: "hook-secret" };
    const port = await getFreePort();
    const server = await startGatewayServer(port);
    const res = await fetch(`http://127.0.0.1:${port}/hooks/wake`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-clawdis-token": "hook-secret",
      },
      body: JSON.stringify({ text: "Header auth" }),
    });
    expect(res.status).toBe(200);
    const events = await waitForSystemEvent();
    expect(events.some((e) => e.includes("Header auth"))).toBe(true);
    drainSystemEvents();
    await server.close();
  });

  test("hooks rejects non-post", async () => {
    testHooksConfig = { enabled: true, token: "hook-secret" };
    const port = await getFreePort();
    const server = await startGatewayServer(port);
    const res = await fetch(`http://127.0.0.1:${port}/hooks/wake`, {
      method: "GET",
      headers: { Authorization: "Bearer hook-secret" },
    });
    expect(res.status).toBe(405);
    await server.close();
  });

  test("hooks wake requires text", async () => {
    testHooksConfig = { enabled: true, token: "hook-secret" };
    const port = await getFreePort();
    const server = await startGatewayServer(port);
    const res = await fetch(`http://127.0.0.1:${port}/hooks/wake`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer hook-secret",
      },
      body: JSON.stringify({ text: " " }),
    });
    expect(res.status).toBe(400);
    await server.close();
  });

  test("hooks agent requires message", async () => {
    testHooksConfig = { enabled: true, token: "hook-secret" };
    const port = await getFreePort();
    const server = await startGatewayServer(port);
    const res = await fetch(`http://127.0.0.1:${port}/hooks/agent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer hook-secret",
      },
      body: JSON.stringify({ message: " " }),
    });
    expect(res.status).toBe(400);
    await server.close();
  });

  test("hooks rejects invalid json", async () => {
    testHooksConfig = { enabled: true, token: "hook-secret" };
    const port = await getFreePort();
    const server = await startGatewayServer(port);
    const res = await fetch(`http://127.0.0.1:${port}/hooks/wake`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer hook-secret",
      },
      body: "{",
    });
    expect(res.status).toBe(400);
    await server.close();
  });
});
