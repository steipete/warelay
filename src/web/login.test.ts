import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetLogger, setLoggerOverride } from "../logging.js";
import { loginWeb } from "./login.js";
import type { waitForWaConnection } from "./session.js";
import {
  baileys,
  resetBaileysMocks,
  resetLoadConfigMock,
} from "./test-helpers.js";

describe("web login", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetBaileysMocks();
    resetLoadConfigMock();
  });

  afterEach(() => {
    resetLogger();
    setLoggerOverride(null);
  });

  it("loginWeb waits for connection and closes", async () => {
    const closeSpy = vi.fn();
    const ev = new EventEmitter();
    baileys.makeWASocket.mockImplementation(() => ({
      ev,
      ws: { close: closeSpy },
      sendPresenceUpdate: vi.fn(),
      sendMessage: vi.fn(),
    }));
    const waiter: typeof waitForWaConnection = vi
      .fn()
      .mockResolvedValue(undefined);
    await loginWeb(false, waiter);
    await new Promise((resolve) => setTimeout(resolve, 550));
    expect(closeSpy).toHaveBeenCalled();
  });
});
