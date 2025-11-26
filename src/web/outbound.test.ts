import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetLogger, setLoggerOverride } from "../logging.js";
import { sendMessageWeb } from "./outbound.js";
import {
  getLastSocket,
  resetBaileysMocks,
  resetLoadConfigMock,
} from "./test-helpers.js";

describe("web outbound", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetBaileysMocks();
    resetLoadConfigMock();
  });

  afterEach(() => {
    resetLogger();
    setLoggerOverride(null);
  });

  it("sends message via web and closes socket", async () => {
    await sendMessageWeb("+1555", "hi", { verbose: false });
    const sock = getLastSocket();
    expect(sock.sendMessage).toHaveBeenCalled();
    expect(sock.ws.close).toHaveBeenCalled();
  });
});
