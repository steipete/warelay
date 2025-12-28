/**
 * Unified prerequisite checking module for Clawdis.
 * Used by install scripts, setup wizard, and `clawdis doctor` command.
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { detectRuntime, isAtLeast, parseSemver } from "./runtime-guard.js";

export type PrerequisiteStatus = "ok" | "warning" | "error" | "skipped";

export interface PrerequisiteResult {
  name: string;
  status: PrerequisiteStatus;
  version?: string;
  required?: string;
  message: string;
  hint?: string;
  /** If set, this issue can be auto-fixed by calling the corresponding fix function */
  fixId?: FixableIssue;
}

/** Identifiers for issues that can be auto-fixed */
export type FixableIssue =
  | "setup-config"
  | "setup-workspace"
  | "whatsapp-login"
  | "anthropic-key";

export interface PrerequisiteCheck {
  name: string;
  category: "runtime" | "tools" | "credentials" | "network";
  required: boolean;
  check: () => Promise<PrerequisiteResult>;
}

const MIN_NODE = { major: 22, minor: 0, patch: 0 };

// ─────────────────────────────────────────────────────────────────────────────
// Individual Checks
// ─────────────────────────────────────────────────────────────────────────────

async function checkNodeVersion(): Promise<PrerequisiteResult> {
  const details = detectRuntime();
  const parsed = parseSemver(details.version);
  const ok = isAtLeast(parsed, MIN_NODE);

  return {
    name: "Node.js",
    status: ok ? "ok" : "error",
    version: details.version ?? "unknown",
    required: `>= ${MIN_NODE.major}.${MIN_NODE.minor}.${MIN_NODE.patch}`,
    message: ok
      ? `Node.js ${details.version} detected`
      : `Node.js ${details.version ?? "unknown"} is too old`,
    hint: ok
      ? undefined
      : "Install Node.js 22+: https://nodejs.org/en/download or use nvm/fnm",
  };
}

async function checkPnpm(): Promise<PrerequisiteResult> {
  try {
    const version = execSync("pnpm --version", { encoding: "utf-8" }).trim();
    return {
      name: "pnpm",
      status: "ok",
      version,
      message: `pnpm ${version} detected`,
    };
  } catch {
    return {
      name: "pnpm",
      status: "error",
      message: "pnpm not found in PATH",
      hint: "Install pnpm: npm install -g pnpm or corepack enable",
    };
  }
}

async function checkGit(): Promise<PrerequisiteResult> {
  try {
    const version = execSync("git --version", { encoding: "utf-8" })
      .trim()
      .replace("git version ", "");
    return {
      name: "Git",
      status: "ok",
      version,
      message: `Git ${version} detected`,
    };
  } catch {
    return {
      name: "Git",
      status: "warning",
      message: "Git not found (optional, needed for updates)",
      hint: "Install Git: https://git-scm.com/downloads",
    };
  }
}

async function checkWhatsAppCredentials(): Promise<PrerequisiteResult> {
  const credsDir = path.join(os.homedir(), ".clawdis", "credentials");
  const credsFile = path.join(credsDir, "creds.json");

  try {
    const stat = fs.statSync(credsFile);
    if (stat.isFile() && stat.size > 0) {
      return {
        name: "WhatsApp Credentials",
        status: "ok",
        message: "WhatsApp credentials found",
      };
    }
    return {
      name: "WhatsApp Credentials",
      status: "warning",
      message: "Credentials file exists but is empty",
      hint: "Run: clawdis login",
      fixId: "whatsapp-login",
    };
  } catch {
    return {
      name: "WhatsApp Credentials",
      status: "warning",
      message: "No WhatsApp credentials found",
      hint: "Run: clawdis login (scan QR code with your phone)",
      fixId: "whatsapp-login",
    };
  }
}

async function checkTelegramToken(): Promise<PrerequisiteResult> {
  const token =
    process.env.TELEGRAM_BOT_TOKEN ||
    process.env.CLAWDIS_TELEGRAM_BOT_TOKEN ||
    "";

  // Also check config file
  const configPath = path.join(os.homedir(), ".clawdis", "clawdis.json");
  let configToken = "";
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw);
    configToken = config?.telegram?.botToken || "";
  } catch {
    // Config doesn't exist or is invalid
  }

  const hasToken = Boolean(token || configToken);

  return {
    name: "Telegram Bot Token",
    status: hasToken ? "ok" : "skipped",
    message: hasToken
      ? "Telegram bot token configured"
      : "Telegram bot token not set (optional)",
    hint: hasToken
      ? undefined
      : "Set TELEGRAM_BOT_TOKEN env var or telegram.botToken in config",
  };
}

async function checkDiscordToken(): Promise<PrerequisiteResult> {
  const token =
    process.env.DISCORD_BOT_TOKEN ||
    process.env.CLAWDIS_DISCORD_BOT_TOKEN ||
    "";

  // Also check config file
  const configPath = path.join(os.homedir(), ".clawdis", "clawdis.json");
  let configToken = "";
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw);
    configToken = config?.discord?.botToken || "";
  } catch {
    // Config doesn't exist or is invalid
  }

  const hasToken = Boolean(token || configToken);

  return {
    name: "Discord Bot Token",
    status: hasToken ? "ok" : "skipped",
    message: hasToken
      ? "Discord bot token configured"
      : "Discord bot token not set (optional)",
    hint: hasToken
      ? undefined
      : "Set DISCORD_BOT_TOKEN env var or discord.botToken in config",
  };
}

async function checkAnthropicKey(): Promise<PrerequisiteResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY || "";

  // Check for OAuth token in config
  const configPath = path.join(os.homedir(), ".clawdis", "clawdis.json");
  let hasOAuth = false;
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw);
    hasOAuth = Boolean(config?.agent?.oauth?.accessToken);
  } catch {
    // Config doesn't exist or is invalid
  }

  const hasAuth = Boolean(apiKey || hasOAuth);

  return {
    name: "Anthropic API Key",
    status: hasAuth ? "ok" : "error",
    message: hasAuth
      ? apiKey
        ? "ANTHROPIC_API_KEY set"
        : "OAuth token configured"
      : "No Anthropic authentication found",
    hint: hasAuth
      ? undefined
      : "Set ANTHROPIC_API_KEY env var or configure OAuth in settings",
    fixId: hasAuth ? undefined : "anthropic-key",
  };
}

async function checkClawdisConfig(): Promise<PrerequisiteResult> {
  const configPath = path.join(os.homedir(), ".clawdis", "clawdis.json");

  try {
    const stat = fs.statSync(configPath);
    if (stat.isFile()) {
      // Try to parse it
      const raw = fs.readFileSync(configPath, "utf-8");
      JSON.parse(raw);
      return {
        name: "Clawdis Config",
        status: "ok",
        message: `Config found at ${configPath}`,
      };
    }
    return {
      name: "Clawdis Config",
      status: "warning",
      message: "Config file is not a regular file",
      hint: "Run: clawdis setup",
      fixId: "setup-config",
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        name: "Clawdis Config",
        status: "warning",
        message: "No config file found",
        hint: "Run: clawdis setup",
        fixId: "setup-config",
      };
    }
    return {
      name: "Clawdis Config",
      status: "error",
      message: "Config file exists but is invalid JSON",
      hint: "Check syntax in ~/.clawdis/clawdis.json",
    };
  }
}

async function checkWorkspace(): Promise<PrerequisiteResult> {
  // Check default workspace location
  const workspaceDir = path.join(os.homedir(), "clawd");
  const agentsMd = path.join(workspaceDir, "AGENTS.md");

  try {
    const stat = fs.statSync(agentsMd);
    if (stat.isFile()) {
      return {
        name: "Agent Workspace",
        status: "ok",
        message: `Workspace found at ${workspaceDir}`,
      };
    }
    return {
      name: "Agent Workspace",
      status: "warning",
      message: "Workspace directory exists but AGENTS.md missing",
      hint: "Run: clawdis setup",
      fixId: "setup-workspace",
    };
  } catch {
    return {
      name: "Agent Workspace",
      status: "warning",
      message: "No workspace directory found",
      hint: "Run: clawdis setup (creates ~/clawd with template files)",
      fixId: "setup-workspace",
    };
  }
}

async function checkNetworkConnectivity(): Promise<PrerequisiteResult> {
  try {
    // Simple DNS check - doesn't actually make HTTP request
    const dns = await import("node:dns/promises");
    await dns.lookup("api.anthropic.com");
    return {
      name: "Network Connectivity",
      status: "ok",
      message: "Can reach api.anthropic.com",
    };
  } catch {
    return {
      name: "Network Connectivity",
      status: "error",
      message: "Cannot resolve api.anthropic.com",
      hint: "Check your internet connection and DNS settings",
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Exported Check Registry
// ─────────────────────────────────────────────────────────────────────────────

export const PREREQUISITE_CHECKS: PrerequisiteCheck[] = [
  // Runtime checks
  {
    name: "Node.js",
    category: "runtime",
    required: true,
    check: checkNodeVersion,
  },
  {
    name: "pnpm",
    category: "tools",
    required: true,
    check: checkPnpm,
  },
  {
    name: "Git",
    category: "tools",
    required: false,
    check: checkGit,
  },

  // Configuration checks
  {
    name: "Clawdis Config",
    category: "credentials",
    required: false,
    check: checkClawdisConfig,
  },
  {
    name: "Agent Workspace",
    category: "credentials",
    required: false,
    check: checkWorkspace,
  },

  // Provider credentials
  {
    name: "WhatsApp Credentials",
    category: "credentials",
    required: false,
    check: checkWhatsAppCredentials,
  },
  {
    name: "Telegram Bot Token",
    category: "credentials",
    required: false,
    check: checkTelegramToken,
  },
  {
    name: "Discord Bot Token",
    category: "credentials",
    required: false,
    check: checkDiscordToken,
  },

  // API keys
  {
    name: "Anthropic API Key",
    category: "credentials",
    required: true,
    check: checkAnthropicKey,
  },

  // Network
  {
    name: "Network Connectivity",
    category: "network",
    required: true,
    check: checkNetworkConnectivity,
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Main Runner
// ─────────────────────────────────────────────────────────────────────────────

export interface PrerequisitesReport {
  results: PrerequisiteResult[];
  hasErrors: boolean;
  hasWarnings: boolean;
  summary: {
    ok: number;
    warning: number;
    error: number;
    skipped: number;
  };
}

export async function runAllPrerequisiteChecks(): Promise<PrerequisitesReport> {
  const results: PrerequisiteResult[] = [];

  for (const check of PREREQUISITE_CHECKS) {
    try {
      const result = await check.check();
      results.push(result);
    } catch (err) {
      results.push({
        name: check.name,
        status: "error",
        message: `Check failed: ${(err as Error).message}`,
      });
    }
  }

  const summary = {
    ok: results.filter((r) => r.status === "ok").length,
    warning: results.filter((r) => r.status === "warning").length,
    error: results.filter((r) => r.status === "error").length,
    skipped: results.filter((r) => r.status === "skipped").length,
  };

  return {
    results,
    hasErrors: summary.error > 0,
    hasWarnings: summary.warning > 0,
    summary,
  };
}

export async function runRequiredPrerequisiteChecks(): Promise<PrerequisitesReport> {
  const requiredChecks = PREREQUISITE_CHECKS.filter((c) => c.required);
  const results: PrerequisiteResult[] = [];

  for (const check of requiredChecks) {
    try {
      const result = await check.check();
      results.push(result);
    } catch (err) {
      results.push({
        name: check.name,
        status: "error",
        message: `Check failed: ${(err as Error).message}`,
      });
    }
  }

  const summary = {
    ok: results.filter((r) => r.status === "ok").length,
    warning: results.filter((r) => r.status === "warning").length,
    error: results.filter((r) => r.status === "error").length,
    skipped: results.filter((r) => r.status === "skipped").length,
  };

  return {
    results,
    hasErrors: summary.error > 0,
    hasWarnings: summary.warning > 0,
    summary,
  };
}
