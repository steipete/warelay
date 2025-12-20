import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "clawdis-config-"));
  const previousHome = process.env.HOME;
  process.env.HOME = base;
  try {
    return await fn(base);
  } finally {
    process.env.HOME = previousHome;
    await fs.rm(base, { recursive: true, force: true });
  }
}

/**
 * Helper to test env var overrides. Saves/restores env vars and resets modules.
 */
async function withEnvOverride<T>(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
    if (overrides[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = overrides[key];
    }
  }
  vi.resetModules();
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
    vi.resetModules();
  }
}

describe("config identity defaults", () => {
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.HOME;
  });

  afterEach(() => {
    process.env.HOME = previousHome;
  });

  it("derives mentionPatterns when identity is set", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".clawdis");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "clawdis.json"),
        JSON.stringify(
          {
            identity: { name: "Samantha", theme: "helpful sloth", emoji: "🦥" },
            messages: {},
            routing: {},
          },
          null,
          2,
        ),
        "utf-8",
      );

      vi.resetModules();
      const { loadConfig } = await import("./config.js");
      const cfg = loadConfig();

      expect(cfg.messages?.responsePrefix).toBeUndefined();
      expect(cfg.routing?.groupChat?.mentionPatterns).toEqual([
        "\\b@?Samantha\\b",
      ]);
    });
  });

  it("does not override explicit values", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".clawdis");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "clawdis.json"),
        JSON.stringify(
          {
            identity: {
              name: "Samantha Sloth",
              theme: "space lobster",
              emoji: "🦞",
            },
            messages: {
              responsePrefix: "✅",
            },
            routing: {
              groupChat: { mentionPatterns: ["@clawd"] },
            },
          },
          null,
          2,
        ),
        "utf-8",
      );

      vi.resetModules();
      const { loadConfig } = await import("./config.js");
      const cfg = loadConfig();

      expect(cfg.messages?.responsePrefix).toBe("✅");
      expect(cfg.routing?.groupChat?.mentionPatterns).toEqual(["@clawd"]);
    });
  });

  it("respects empty responsePrefix to disable identity defaults", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".clawdis");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "clawdis.json"),
        JSON.stringify(
          {
            identity: { name: "Samantha", theme: "helpful sloth", emoji: "🦥" },
            messages: { responsePrefix: "" },
            routing: {},
          },
          null,
          2,
        ),
        "utf-8",
      );

      vi.resetModules();
      const { loadConfig } = await import("./config.js");
      const cfg = loadConfig();

      expect(cfg.messages?.responsePrefix).toBe("");
    });
  });

  it("does not synthesize agent/session when absent", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".clawdis");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "clawdis.json"),
        JSON.stringify(
          {
            identity: { name: "Samantha", theme: "helpful sloth", emoji: "🦥" },
            messages: {},
            routing: {},
          },
          null,
          2,
        ),
        "utf-8",
      );

      vi.resetModules();
      const { loadConfig } = await import("./config.js");
      const cfg = loadConfig();

      expect(cfg.messages?.responsePrefix).toBeUndefined();
      expect(cfg.routing?.groupChat?.mentionPatterns).toEqual([
        "\\b@?Samantha\\b",
      ]);
      expect(cfg.agent).toBeUndefined();
      expect(cfg.session).toBeUndefined();
    });
  });

  it("does not derive responsePrefix from identity emoji", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".clawdis");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "clawdis.json"),
        JSON.stringify(
          {
            identity: { name: "Clawd", theme: "space lobster", emoji: "🦞" },
            messages: {},
            routing: {},
          },
          null,
          2,
        ),
        "utf-8",
      );

      vi.resetModules();
      const { loadConfig } = await import("./config.js");
      const cfg = loadConfig();

      expect(cfg.messages?.responsePrefix).toBeUndefined();
    });
  });
});

describe("Nix integration (U3, U5, U9)", () => {
  describe("U3: isNixMode env var detection", () => {
    it("isNixMode is false when CLAWDIS_NIX_MODE is not set", async () => {
      await withEnvOverride({ CLAWDIS_NIX_MODE: undefined }, async () => {
        const { isNixMode } = await import("./config.js");
        expect(isNixMode).toBe(false);
      });
    });

    it("isNixMode is false when CLAWDIS_NIX_MODE is empty", async () => {
      await withEnvOverride({ CLAWDIS_NIX_MODE: "" }, async () => {
        const { isNixMode } = await import("./config.js");
        expect(isNixMode).toBe(false);
      });
    });

    it("isNixMode is false when CLAWDIS_NIX_MODE is not '1'", async () => {
      await withEnvOverride({ CLAWDIS_NIX_MODE: "true" }, async () => {
        const { isNixMode } = await import("./config.js");
        expect(isNixMode).toBe(false);
      });
    });

    it("isNixMode is true when CLAWDIS_NIX_MODE=1", async () => {
      await withEnvOverride({ CLAWDIS_NIX_MODE: "1" }, async () => {
        const { isNixMode } = await import("./config.js");
        expect(isNixMode).toBe(true);
      });
    });
  });

  describe("U5: CONFIG_PATH and STATE_DIR env var overrides", () => {
    it("STATE_DIR_CLAWDIS defaults to ~/.clawdis when env not set", async () => {
      await withEnvOverride({ CLAWDIS_STATE_DIR: undefined }, async () => {
        const { STATE_DIR_CLAWDIS } = await import("./config.js");
        expect(STATE_DIR_CLAWDIS).toMatch(/\.clawdis$/);
      });
    });

    it("STATE_DIR_CLAWDIS respects CLAWDIS_STATE_DIR override", async () => {
      await withEnvOverride(
        { CLAWDIS_STATE_DIR: "/custom/state/dir" },
        async () => {
          const { STATE_DIR_CLAWDIS } = await import("./config.js");
          expect(STATE_DIR_CLAWDIS).toBe("/custom/state/dir");
        },
      );
    });

    it("CONFIG_PATH_CLAWDIS defaults to ~/.clawdis/clawdis.json when env not set", async () => {
      await withEnvOverride(
        { CLAWDIS_CONFIG_PATH: undefined, CLAWDIS_STATE_DIR: undefined },
        async () => {
          const { CONFIG_PATH_CLAWDIS } = await import("./config.js");
          expect(CONFIG_PATH_CLAWDIS).toMatch(/\.clawdis\/clawdis\.json$/);
        },
      );
    });

    it("CONFIG_PATH_CLAWDIS respects CLAWDIS_CONFIG_PATH override", async () => {
      await withEnvOverride(
        { CLAWDIS_CONFIG_PATH: "/nix/store/abc/clawdis.json" },
        async () => {
          const { CONFIG_PATH_CLAWDIS } = await import("./config.js");
          expect(CONFIG_PATH_CLAWDIS).toBe("/nix/store/abc/clawdis.json");
        },
      );
    });

    it("CONFIG_PATH_CLAWDIS uses STATE_DIR_CLAWDIS when only state dir is overridden", async () => {
      await withEnvOverride(
        {
          CLAWDIS_CONFIG_PATH: undefined,
          CLAWDIS_STATE_DIR: "/custom/state",
        },
        async () => {
          const { CONFIG_PATH_CLAWDIS } = await import("./config.js");
          expect(CONFIG_PATH_CLAWDIS).toBe("/custom/state/clawdis.json");
        },
      );
    });
  });

  describe("U9: telegram.tokenFile schema validation", () => {
    it("accepts config with only botToken", async () => {
      await withTempHome(async (home) => {
        const configDir = path.join(home, ".clawdis");
        await fs.mkdir(configDir, { recursive: true });
        await fs.writeFile(
          path.join(configDir, "clawdis.json"),
          JSON.stringify({
            telegram: { botToken: "123:ABC" },
          }),
          "utf-8",
        );

        vi.resetModules();
        const { loadConfig } = await import("./config.js");
        const cfg = loadConfig();
        expect(cfg.telegram?.botToken).toBe("123:ABC");
        expect(cfg.telegram?.tokenFile).toBeUndefined();
      });
    });

    it("accepts config with only tokenFile", async () => {
      await withTempHome(async (home) => {
        const configDir = path.join(home, ".clawdis");
        await fs.mkdir(configDir, { recursive: true });
        await fs.writeFile(
          path.join(configDir, "clawdis.json"),
          JSON.stringify({
            telegram: { tokenFile: "/run/agenix/telegram-token" },
          }),
          "utf-8",
        );

        vi.resetModules();
        const { loadConfig } = await import("./config.js");
        const cfg = loadConfig();
        expect(cfg.telegram?.tokenFile).toBe("/run/agenix/telegram-token");
        expect(cfg.telegram?.botToken).toBeUndefined();
      });
    });

    it("accepts config with both botToken and tokenFile", async () => {
      await withTempHome(async (home) => {
        const configDir = path.join(home, ".clawdis");
        await fs.mkdir(configDir, { recursive: true });
        await fs.writeFile(
          path.join(configDir, "clawdis.json"),
          JSON.stringify({
            telegram: {
              botToken: "fallback:token",
              tokenFile: "/run/agenix/telegram-token",
            },
          }),
          "utf-8",
        );

        vi.resetModules();
        const { loadConfig } = await import("./config.js");
        const cfg = loadConfig();
        expect(cfg.telegram?.botToken).toBe("fallback:token");
        expect(cfg.telegram?.tokenFile).toBe("/run/agenix/telegram-token");
      });
    });
  });
});
