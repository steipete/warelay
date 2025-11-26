import { EventEmitter } from "node:events";
import fsSync from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetLogger, setLoggerOverride } from "../logging.js";
import {
  createWaSocket,
  logWebSelfId,
  waitForWaConnection,
} from "./session.js";
import {
  baileys,
  getLastSocket,
  resetBaileysMocks,
  resetLoadConfigMock,
} from "./test-helpers.js";

describe("web session", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetBaileysMocks();
    resetLoadConfigMock();
  });

  afterEach(() => {
    resetLogger();
    setLoggerOverride(null);
    vi.useRealTimers();
  });

  it("creates WA socket with QR handler", async () => {
    await createWaSocket(true, false);
    const makeWASocket = baileys.makeWASocket as ReturnType<typeof vi.fn>;
    expect(makeWASocket).toHaveBeenCalledWith(
      expect.objectContaining({ printQRInTerminal: false }),
    );
    const passed = makeWASocket.mock.calls[0][0];
    const passedLogger = (
      passed as { logger?: { level?: string; trace?: unknown } }
    ).logger;
    expect(passedLogger?.level).toBe("silent");
    expect(typeof passedLogger?.trace).toBe("function");
    const sock = getLastSocket();
    const saveCreds = (
      await baileys.useMultiFileAuthState.mock.results[0].value
    ).saveCreds;
    // trigger creds.update listener
    sock.ev.emit("creds.update", {});
    expect(saveCreds).toHaveBeenCalled();
  });

  it("waits for connection open", async () => {
    const ev = new EventEmitter();
    const promise = waitForWaConnection({ ev } as unknown as ReturnType<
      typeof baileys.makeWASocket
    >);
    ev.emit("connection.update", { connection: "open" });
    await expect(promise).resolves.toBeUndefined();
  });

  it("rejects when connection closes", async () => {
    const ev = new EventEmitter();
    const promise = waitForWaConnection({ ev } as unknown as ReturnType<
      typeof baileys.makeWASocket
    >);
    ev.emit("connection.update", {
      connection: "close",
      lastDisconnect: new Error("bye"),
    });
    await expect(promise).rejects.toBeInstanceOf(Error);
  });

  it("logWebSelfId prints cached E.164 when creds exist", () => {
    const existsSpy = vi
      .spyOn(fsSync, "existsSync")
      .mockReturnValue(true as never);
    const readSpy = vi
      .spyOn(fsSync, "readFileSync")
      .mockReturnValue(JSON.stringify({ me: { id: "12345@s.whatsapp.net" } }));
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    logWebSelfId(runtime as never, true);

    expect(runtime.log).toHaveBeenCalledWith(
      "Web Provider: +12345 (jid 12345@s.whatsapp.net)",
    );
    existsSpy.mockRestore();
    readSpy.mockRestore();
  });
});
