import { describe, expect, it } from "vitest";

import { buildEmbeddedSandboxInfo } from "./pi-embedded-runner.js";
import type { SandboxContext } from "./sandbox.js";

describe("buildEmbeddedSandboxInfo", () => {
  it("returns undefined when sandbox is missing", () => {
    expect(buildEmbeddedSandboxInfo()).toBeUndefined();
  });

  it("maps sandbox context into prompt info", () => {
    const sandbox = {
      enabled: true,
      sessionKey: "session:test",
      workspaceDir: "/tmp/clawdis-sandbox",
      containerName: "clawdis-sbx-test",
      containerWorkdir: "/workspace",
      docker: {
        image: "clawdis-sandbox:bookworm-slim",
        containerPrefix: "clawdis-sbx-",
        workdir: "/workspace",
        readOnlyRoot: true,
        tmpfs: ["/tmp"],
        network: "none",
        user: "1000:1000",
        capDrop: ["ALL"],
        env: { LANG: "C.UTF-8" },
      },
      tools: {
        allow: ["bash"],
        deny: ["browser"],
      },
      browser: {
        controlUrl: "http://localhost:9222",
        noVncUrl: "http://localhost:6080",
        containerName: "clawdis-sbx-browser-test",
      },
    } satisfies SandboxContext;

    expect(buildEmbeddedSandboxInfo(sandbox)).toEqual({
      enabled: true,
      workspaceDir: "/tmp/clawdis-sandbox",
      browserControlUrl: "http://localhost:9222",
      browserNoVncUrl: "http://localhost:6080",
    });
  });
});
