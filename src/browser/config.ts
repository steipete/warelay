import type { BrowserConfig, BrowserProfileConfig } from "../config/config.js";
import {
  DEFAULT_CLAWD_BROWSER_COLOR,
  DEFAULT_CLAWD_BROWSER_CONTROL_URL,
  DEFAULT_CLAWD_BROWSER_ENABLED,
  DEFAULT_CLAWD_BROWSER_PROFILE_NAME,
} from "./constants.js";
import { CDP_PORT_RANGE_START } from "./profiles.js";

export type ResolvedBrowserConfig = {
  enabled: boolean;
  controlUrl: string;
  controlHost: string;
  controlPort: number;
  cdpHost: string;
  cdpIsLoopback: boolean;
  color: string;
  executablePath?: string;
  headless: boolean;
  noSandbox: boolean;
  attachOnly: boolean;
  defaultProfile: string;
  profiles: Record<string, BrowserProfileConfig>;
};

export type ResolvedBrowserProfile = {
  name: string;
  cdpPort: number;
  cdpUrl: string;
  color: string;
};

function isLoopbackHost(host: string) {
  const h = host.trim().toLowerCase();
  return (
    h === "localhost" ||
    h === "127.0.0.1" ||
    h === "0.0.0.0" ||
    h === "[::1]" ||
    h === "::1" ||
    h === "[::]" ||
    h === "::"
  );
}

function normalizeHexColor(raw: string | undefined) {
  const value = (raw ?? "").trim();
  if (!value) return DEFAULT_CLAWD_BROWSER_COLOR;
  const normalized = value.startsWith("#") ? value : `#${value}`;
  if (!/^#[0-9a-fA-F]{6}$/.test(normalized)) return DEFAULT_CLAWD_BROWSER_COLOR;
  return normalized.toUpperCase();
}

function parseHttpUrl(raw: string, label: string) {
  const trimmed = raw.trim();
  const parsed = new URL(trimmed);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `${label} must be http(s), got: ${parsed.protocol.replace(":", "")}`,
    );
  }

  const port =
    parsed.port && Number.parseInt(parsed.port, 10) > 0
      ? Number.parseInt(parsed.port, 10)
      : parsed.protocol === "https:"
        ? 443
        : 80;

  if (Number.isNaN(port) || port <= 0 || port > 65535) {
    throw new Error(`${label} has invalid port: ${parsed.port}`);
  }

  return {
    parsed,
    port,
    normalized: parsed.toString().replace(/\/$/, ""),
  };
}

/**
 * Ensure the default "clawd" profile exists in the profiles map.
 * Auto-creates it with the legacy CDP port (from browser.cdpUrl) or first port if missing.
 */
function ensureDefaultProfile(
  profiles: Record<string, BrowserProfileConfig> | undefined,
  defaultColor: string,
  legacyCdpPort?: number,
): Record<string, BrowserProfileConfig> {
  const result = { ...profiles };
  if (!result[DEFAULT_CLAWD_BROWSER_PROFILE_NAME]) {
    result[DEFAULT_CLAWD_BROWSER_PROFILE_NAME] = {
      cdpPort: legacyCdpPort ?? CDP_PORT_RANGE_START,
      color: defaultColor,
    };
  }
  return result;
}

export function resolveBrowserConfig(
  cfg: BrowserConfig | undefined,
): ResolvedBrowserConfig {
  const enabled = cfg?.enabled ?? DEFAULT_CLAWD_BROWSER_ENABLED;
  const controlInfo = parseHttpUrl(
    cfg?.controlUrl ?? DEFAULT_CLAWD_BROWSER_CONTROL_URL,
    "browser.controlUrl",
  );
  const controlPort = controlInfo.port;
  const defaultColor = normalizeHexColor(cfg?.color);

  const rawCdpUrl = (cfg?.cdpUrl ?? "").trim();
  let cdpInfo:
    | {
        parsed: URL;
        port: number;
        normalized: string;
      }
    | undefined;
  if (rawCdpUrl) {
    cdpInfo = parseHttpUrl(rawCdpUrl, "browser.cdpUrl");
  } else {
    const derivedPort = controlPort + 1;
    if (derivedPort > 65535) {
      throw new Error(
        `browser.controlUrl port (${controlPort}) is too high; cannot derive CDP port (${derivedPort})`,
      );
    }
    const derived = new URL(controlInfo.normalized);
    derived.port = String(derivedPort);
    cdpInfo = {
      parsed: derived,
      port: derivedPort,
      normalized: derived.toString().replace(/\/$/, ""),
    };
  }

  const headless = cfg?.headless === true;
  const noSandbox = cfg?.noSandbox === true;
  const attachOnly = cfg?.attachOnly === true;
  const executablePath = cfg?.executablePath?.trim() || undefined;

  const defaultProfile =
    cfg?.defaultProfile ?? DEFAULT_CLAWD_BROWSER_PROFILE_NAME;
  // Use legacy cdpUrl port for backward compatibility when no profiles configured
  const legacyCdpPort = rawCdpUrl ? cdpInfo.port : undefined;
  const profiles = ensureDefaultProfile(
    cfg?.profiles,
    defaultColor,
    legacyCdpPort,
  );

  return {
    enabled,
    controlUrl: controlInfo.normalized,
    controlHost: controlInfo.parsed.hostname,
    controlPort,
    cdpHost: cdpInfo.parsed.hostname,
    cdpIsLoopback: isLoopbackHost(cdpInfo.parsed.hostname),
    color: defaultColor,
    executablePath,
    headless,
    noSandbox,
    attachOnly,
    defaultProfile,
    profiles,
  };
}

/**
 * Resolve a profile by name from the config.
 * Returns null if the profile doesn't exist.
 */
export function resolveProfile(
  resolved: ResolvedBrowserConfig,
  profileName: string,
): ResolvedBrowserProfile | null {
  const profile = resolved.profiles[profileName];
  if (!profile) return null;

  return {
    name: profileName,
    cdpPort: profile.cdpPort,
    cdpUrl: `http://${resolved.cdpHost}:${profile.cdpPort}`,
    color: profile.color,
  };
}

export function shouldStartLocalBrowserServer(resolved: ResolvedBrowserConfig) {
  return isLoopbackHost(resolved.controlHost);
}
