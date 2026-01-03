import fs from "node:fs";
import path from "node:path";

import type express from "express";

import {
  type ClawdisConfig,
  loadConfig,
  writeConfigFile,
} from "../../config/config.js";
import { resolveClawdUserDataDir } from "../chrome.js";
import {
  allocateCdpPort,
  allocateColor,
  getUsedColors,
  getUsedPorts,
  isValidProfileName,
} from "../profiles.js";
import type { BrowserRouteContext } from "../server-context.js";
import { getProfileContext, jsonError, toStringOrEmpty } from "./utils.js";

export function registerBrowserBasicRoutes(
  app: express.Express,
  ctx: BrowserRouteContext,
) {
  // List all profiles with their status
  app.get("/profiles", async (_req, res) => {
    try {
      const profiles = await ctx.listProfiles();
      res.json({ profiles });
    } catch (err) {
      jsonError(res, 500, String(err));
    }
  });

  // Get status (profile-aware)
  app.get("/", async (req, res) => {
    let current: ReturnType<typeof ctx.state>;
    try {
      current = ctx.state();
    } catch {
      return jsonError(res, 503, "browser server not started");
    }

    const profileCtx = getProfileContext(req, ctx);
    if ("error" in profileCtx) {
      return jsonError(res, profileCtx.status, profileCtx.error);
    }

    const [cdpHttp, cdpReady] = await Promise.all([
      profileCtx.isHttpReachable(300),
      profileCtx.isReachable(600),
    ]);

    const profileState = current.profiles.get(profileCtx.profile.name);

    res.json({
      enabled: current.resolved.enabled,
      controlUrl: current.resolved.controlUrl,
      profile: profileCtx.profile.name,
      running: cdpReady,
      cdpReady,
      cdpHttp,
      pid: profileState?.running?.pid ?? null,
      cdpPort: profileCtx.profile.cdpPort,
      cdpUrl: profileCtx.profile.cdpUrl,
      chosenBrowser: profileState?.running?.exe.kind ?? null,
      userDataDir: profileState?.running?.userDataDir ?? null,
      color: profileCtx.profile.color,
      headless: current.resolved.headless,
      noSandbox: current.resolved.noSandbox,
      executablePath: current.resolved.executablePath ?? null,
      attachOnly: current.resolved.attachOnly,
    });
  });

  // Start browser (profile-aware)
  app.post("/start", async (req, res) => {
    const profileCtx = getProfileContext(req, ctx);
    if ("error" in profileCtx) {
      return jsonError(res, profileCtx.status, profileCtx.error);
    }

    try {
      await profileCtx.ensureBrowserAvailable();
      res.json({ ok: true, profile: profileCtx.profile.name });
    } catch (err) {
      jsonError(res, 500, String(err));
    }
  });

  // Stop browser (profile-aware)
  app.post("/stop", async (req, res) => {
    const profileCtx = getProfileContext(req, ctx);
    if ("error" in profileCtx) {
      return jsonError(res, profileCtx.status, profileCtx.error);
    }

    try {
      const result = await profileCtx.stopRunningBrowser();
      res.json({
        ok: true,
        stopped: result.stopped,
        profile: profileCtx.profile.name,
      });
    } catch (err) {
      jsonError(res, 500, String(err));
    }
  });

  // Reset profile (profile-aware)
  app.post("/reset-profile", async (req, res) => {
    const profileCtx = getProfileContext(req, ctx);
    if ("error" in profileCtx) {
      return jsonError(res, profileCtx.status, profileCtx.error);
    }

    try {
      const result = await profileCtx.resetProfile();
      res.json({ ok: true, profile: profileCtx.profile.name, ...result });
    } catch (err) {
      jsonError(res, 500, String(err));
    }
  });

  // Create a new profile
  app.post("/profiles/create", async (req, res) => {
    const name = toStringOrEmpty((req.body as { name?: unknown })?.name);
    const color = toStringOrEmpty((req.body as { color?: unknown })?.color);

    if (!name) return jsonError(res, 400, "name is required");
    if (!isValidProfileName(name)) {
      return jsonError(
        res,
        400,
        "invalid profile name: use lowercase letters, numbers, and hyphens only",
      );
    }

    try {
      const cfg = loadConfig();
      // Use resolved profiles which includes implicit default (clawd at 18800)
      const state = ctx.state();
      const resolvedProfiles = state.resolved.profiles;

      // Check if profile already exists (in resolved, not just raw config)
      if (name in resolvedProfiles) {
        return jsonError(res, 409, `profile "${name}" already exists`);
      }

      // Allocate port using resolved profiles to avoid collision with implicit default
      const usedPorts = getUsedPorts(resolvedProfiles);
      const cdpPort = allocateCdpPort(usedPorts);
      if (cdpPort === null) {
        return jsonError(res, 507, "no available CDP ports in range");
      }

      const usedColors = getUsedColors(resolvedProfiles);
      const profileColor =
        color && /^#[0-9A-Fa-f]{6}$/.test(color)
          ? color
          : allocateColor(usedColors);

      // Update config file
      const rawProfiles = cfg.browser?.profiles ?? {};
      const nextConfig: ClawdisConfig = {
        ...cfg,
        browser: {
          ...cfg.browser,
          profiles: {
            ...rawProfiles,
            [name]: { cdpPort, color: profileColor },
          },
        },
      };

      await writeConfigFile(nextConfig);

      // Update runtime state so new profile is immediately visible
      state.resolved.profiles[name] = { cdpPort, color: profileColor };

      res.json({
        ok: true,
        profile: name,
        cdpPort,
        color: profileColor,
      });
    } catch (err) {
      jsonError(res, 500, String(err));
    }
  });

  // Delete a profile
  app.delete("/profiles/:name", async (req, res) => {
    const name = toStringOrEmpty(req.params.name);
    if (!name) return jsonError(res, 400, "profile name is required");
    if (!isValidProfileName(name)) {
      return jsonError(res, 400, "invalid profile name");
    }

    try {
      const cfg = loadConfig();
      const profiles = cfg.browser?.profiles ?? {};

      // Check if profile exists
      if (!(name in profiles)) {
        return jsonError(res, 404, `profile "${name}" not found`);
      }

      // Prevent deleting default profile
      const defaultProfile = cfg.browser?.defaultProfile ?? "clawd";
      if (name === defaultProfile) {
        return jsonError(
          res,
          400,
          `cannot delete the default profile "${name}"; change browser.defaultProfile first`,
        );
      }

      // Stop the browser if running
      try {
        const profileCtx = ctx.forProfile(name);
        await profileCtx.stopRunningBrowser();
      } catch {
        // Profile may not be in resolved config yet - ignore
      }

      // Remove user data directory
      const userDataDir = resolveClawdUserDataDir(name);
      const profileDir = path.dirname(userDataDir);
      let deleted = false;
      if (fs.existsSync(profileDir)) {
        fs.rmSync(profileDir, { recursive: true, force: true });
        deleted = true;
      }

      // Update config
      const { [name]: _removed, ...remainingProfiles } = profiles;
      const nextConfig: ClawdisConfig = {
        ...cfg,
        browser: {
          ...cfg.browser,
          profiles: remainingProfiles,
        },
      };

      await writeConfigFile(nextConfig);

      // Clear runtime state (both resolved config and runtime map)
      const state = ctx.state();
      delete state.resolved.profiles[name];
      state.profiles.delete(name);

      res.json({
        ok: true,
        profile: name,
        deleted,
      });
    } catch (err) {
      jsonError(res, 500, String(err));
    }
  });
}
