import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  type BrowserBridge,
  startBrowserBridgeServer,
  stopBrowserBridgeServer,
} from "../browser/bridge-server.js";
import type { ResolvedBrowserConfig } from "../browser/config.js";
import { DEFAULT_CLAWD_BROWSER_COLOR } from "../browser/constants.js";
import type { ClawdisConfig } from "../config/config.js";
import { STATE_DIR_CLAWDIS } from "../config/config.js";
import { defaultRuntime } from "../runtime.js";
import { resolveUserPath } from "../utils.js";
import {
  DEFAULT_AGENT_WORKSPACE_DIR,
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_BOOTSTRAP_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_TOOLS_FILENAME,
  DEFAULT_USER_FILENAME,
  ensureAgentWorkspace,
} from "./workspace.js";

export type SandboxToolPolicy = {
  allow?: string[];
  deny?: string[];
};

export type SandboxBrowserConfig = {
  enabled: boolean;
  image: string;
  containerPrefix: string;
  cdpPort: number;
  vncPort: number;
  noVncPort: number;
  headless: boolean;
  enableNoVnc: boolean;
};

export type SandboxDockerConfig = {
  image: string;
  containerPrefix: string;
  workdir: string;
  readOnlyRoot: boolean;
  tmpfs: string[];
  network: string;
  user?: string;
  capDrop: string[];
  env?: Record<string, string>;
  setupCommand?: string;
};

export type SandboxPruneConfig = {
  idleHours: number;
  maxAgeDays: number;
};

export type SandboxConfig = {
  mode: "off" | "non-main" | "all";
  perSession: boolean;
  workspaceRoot: string;
  docker: SandboxDockerConfig;
  browser: SandboxBrowserConfig;
  tools: SandboxToolPolicy;
  prune: SandboxPruneConfig;
};

export type SandboxBrowserContext = {
  controlUrl: string;
  noVncUrl?: string;
  containerName: string;
};

export type SandboxContext = {
  enabled: boolean;
  sessionKey: string;
  workspaceDir: string;
  containerName: string;
  containerWorkdir: string;
  docker: SandboxDockerConfig;
  tools: SandboxToolPolicy;
  browser?: SandboxBrowserContext;
};

const DEFAULT_SANDBOX_WORKSPACE_ROOT = path.join(
  os.homedir(),
  ".clawdis",
  "sandboxes",
);
const DEFAULT_SANDBOX_IMAGE = "clawdis-sandbox:bookworm-slim";
const DEFAULT_SANDBOX_CONTAINER_PREFIX = "clawdis-sbx-";
const DEFAULT_SANDBOX_WORKDIR = "/workspace";
const DEFAULT_SANDBOX_IDLE_HOURS = 24;
const DEFAULT_SANDBOX_MAX_AGE_DAYS = 7;
const DEFAULT_TOOL_ALLOW = ["bash", "process", "read", "write", "edit"];
const DEFAULT_TOOL_DENY = [
  "browser",
  "canvas",
  "nodes",
  "cron",
  "discord",
  "gateway",
];
const DEFAULT_SANDBOX_BROWSER_IMAGE = "clawdis-sandbox-browser:bookworm-slim";
const DEFAULT_SANDBOX_BROWSER_PREFIX = "clawdis-sbx-browser-";
const DEFAULT_SANDBOX_BROWSER_CDP_PORT = 9222;
const DEFAULT_SANDBOX_BROWSER_VNC_PORT = 5900;
const DEFAULT_SANDBOX_BROWSER_NOVNC_PORT = 6080;

const SANDBOX_STATE_DIR = path.join(STATE_DIR_CLAWDIS, "sandbox");
const SANDBOX_REGISTRY_PATH = path.join(SANDBOX_STATE_DIR, "containers.json");
const SANDBOX_BROWSER_REGISTRY_PATH = path.join(
  SANDBOX_STATE_DIR,
  "browsers.json",
);

type SandboxRegistryEntry = {
  containerName: string;
  sessionKey: string;
  createdAtMs: number;
  lastUsedAtMs: number;
  image: string;
};

type SandboxRegistry = {
  entries: SandboxRegistryEntry[];
};

type SandboxBrowserRegistryEntry = {
  containerName: string;
  sessionKey: string;
  createdAtMs: number;
  lastUsedAtMs: number;
  image: string;
  cdpPort: number;
  noVncPort?: number;
};

type SandboxBrowserRegistry = {
  entries: SandboxBrowserRegistryEntry[];
};

let lastPruneAtMs = 0;
const BROWSER_BRIDGES = new Map<
  string,
  { bridge: BrowserBridge; containerName: string }
>();

function normalizeToolList(values?: string[]) {
  if (!values) return [];
  return values
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => value.toLowerCase());
}

function isToolAllowed(policy: SandboxToolPolicy, name: string) {
  const deny = new Set(normalizeToolList(policy.deny));
  if (deny.has(name.toLowerCase())) return false;
  const allow = normalizeToolList(policy.allow);
  if (allow.length === 0) return true;
  return allow.includes(name.toLowerCase());
}

function defaultSandboxConfig(cfg?: ClawdisConfig): SandboxConfig {
  const agent = cfg?.agent?.sandbox;
  return {
    mode: agent?.mode ?? "off",
    perSession: agent?.perSession ?? true,
    workspaceRoot: agent?.workspaceRoot ?? DEFAULT_SANDBOX_WORKSPACE_ROOT,
    docker: {
      image: agent?.docker?.image ?? DEFAULT_SANDBOX_IMAGE,
      containerPrefix:
        agent?.docker?.containerPrefix ?? DEFAULT_SANDBOX_CONTAINER_PREFIX,
      workdir: agent?.docker?.workdir ?? DEFAULT_SANDBOX_WORKDIR,
      readOnlyRoot: agent?.docker?.readOnlyRoot ?? true,
      tmpfs: agent?.docker?.tmpfs ?? ["/tmp", "/var/tmp", "/run"],
      network: agent?.docker?.network ?? "bridge",
      user: agent?.docker?.user,
      capDrop: agent?.docker?.capDrop ?? ["ALL"],
      env: agent?.docker?.env ?? { LANG: "C.UTF-8" },
      setupCommand: agent?.docker?.setupCommand,
    },
    browser: {
      enabled: agent?.browser?.enabled ?? false,
      image: agent?.browser?.image ?? DEFAULT_SANDBOX_BROWSER_IMAGE,
      containerPrefix:
        agent?.browser?.containerPrefix ?? DEFAULT_SANDBOX_BROWSER_PREFIX,
      cdpPort: agent?.browser?.cdpPort ?? DEFAULT_SANDBOX_BROWSER_CDP_PORT,
      vncPort: agent?.browser?.vncPort ?? DEFAULT_SANDBOX_BROWSER_VNC_PORT,
      noVncPort:
        agent?.browser?.noVncPort ?? DEFAULT_SANDBOX_BROWSER_NOVNC_PORT,
      headless: agent?.browser?.headless ?? false,
      enableNoVnc: agent?.browser?.enableNoVnc ?? true,
    },
    tools: {
      allow: agent?.tools?.allow ?? DEFAULT_TOOL_ALLOW,
      deny: agent?.tools?.deny ?? DEFAULT_TOOL_DENY,
    },
    prune: {
      idleHours: agent?.prune?.idleHours ?? DEFAULT_SANDBOX_IDLE_HOURS,
      maxAgeDays: agent?.prune?.maxAgeDays ?? DEFAULT_SANDBOX_MAX_AGE_DAYS,
    },
  };
}

function shouldSandboxSession(
  cfg: SandboxConfig,
  sessionKey: string,
  mainKey: string,
) {
  if (cfg.mode === "off") return false;
  if (cfg.mode === "all") return true;
  return sessionKey.trim() !== mainKey.trim();
}

function slugifySessionKey(value: string) {
  const trimmed = value.trim() || "session";
  const hash = crypto
    .createHash("sha1")
    .update(trimmed)
    .digest("hex")
    .slice(0, 8);
  const safe = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const base = safe.slice(0, 32) || "session";
  return `${base}-${hash}`;
}

function resolveSandboxWorkspaceDir(root: string, sessionKey: string) {
  const resolvedRoot = resolveUserPath(root);
  const slug = slugifySessionKey(sessionKey);
  return path.join(resolvedRoot, slug);
}

async function readRegistry(): Promise<SandboxRegistry> {
  try {
    const raw = await fs.readFile(SANDBOX_REGISTRY_PATH, "utf-8");
    const parsed = JSON.parse(raw) as SandboxRegistry;
    if (parsed && Array.isArray(parsed.entries)) return parsed;
  } catch {
    // ignore
  }
  return { entries: [] };
}

async function writeRegistry(registry: SandboxRegistry) {
  await fs.mkdir(SANDBOX_STATE_DIR, { recursive: true });
  await fs.writeFile(
    SANDBOX_REGISTRY_PATH,
    `${JSON.stringify(registry, null, 2)}\n`,
    "utf-8",
  );
}

async function updateRegistry(entry: SandboxRegistryEntry) {
  const registry = await readRegistry();
  const existing = registry.entries.find(
    (item) => item.containerName === entry.containerName,
  );
  const next = registry.entries.filter(
    (item) => item.containerName !== entry.containerName,
  );
  next.push({
    ...entry,
    createdAtMs: existing?.createdAtMs ?? entry.createdAtMs,
    image: existing?.image ?? entry.image,
  });
  await writeRegistry({ entries: next });
}

async function removeRegistryEntry(containerName: string) {
  const registry = await readRegistry();
  const next = registry.entries.filter(
    (item) => item.containerName !== containerName,
  );
  if (next.length === registry.entries.length) return;
  await writeRegistry({ entries: next });
}

async function readBrowserRegistry(): Promise<SandboxBrowserRegistry> {
  try {
    const raw = await fs.readFile(SANDBOX_BROWSER_REGISTRY_PATH, "utf-8");
    const parsed = JSON.parse(raw) as SandboxBrowserRegistry;
    if (parsed && Array.isArray(parsed.entries)) return parsed;
  } catch {
    // ignore
  }
  return { entries: [] };
}

async function writeBrowserRegistry(registry: SandboxBrowserRegistry) {
  await fs.mkdir(SANDBOX_STATE_DIR, { recursive: true });
  await fs.writeFile(
    SANDBOX_BROWSER_REGISTRY_PATH,
    `${JSON.stringify(registry, null, 2)}\n`,
    "utf-8",
  );
}

async function updateBrowserRegistry(entry: SandboxBrowserRegistryEntry) {
  const registry = await readBrowserRegistry();
  const existing = registry.entries.find(
    (item) => item.containerName === entry.containerName,
  );
  const next = registry.entries.filter(
    (item) => item.containerName !== entry.containerName,
  );
  next.push({
    ...entry,
    createdAtMs: existing?.createdAtMs ?? entry.createdAtMs,
    image: existing?.image ?? entry.image,
  });
  await writeBrowserRegistry({ entries: next });
}

async function removeBrowserRegistryEntry(containerName: string) {
  const registry = await readBrowserRegistry();
  const next = registry.entries.filter(
    (item) => item.containerName !== containerName,
  );
  if (next.length === registry.entries.length) return;
  await writeBrowserRegistry({ entries: next });
}

function execDocker(args: string[], opts?: { allowFailure?: boolean }) {
  return new Promise<{ stdout: string; stderr: string; code: number }>(
    (resolve, reject) => {
      const child = spawn("docker", args, {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("close", (code) => {
        const exitCode = code ?? 0;
        if (exitCode !== 0 && !opts?.allowFailure) {
          reject(new Error(stderr.trim() || `docker ${args.join(" ")} failed`));
          return;
        }
        resolve({ stdout, stderr, code: exitCode });
      });
    },
  );
}

async function readDockerPort(containerName: string, port: number) {
  const result = await execDocker(["port", containerName, `${port}/tcp`], {
    allowFailure: true,
  });
  if (result.code !== 0) return null;
  const line = result.stdout.trim().split(/\r?\n/)[0] ?? "";
  const match = line.match(/:(\d+)\s*$/);
  if (!match) return null;
  const mapped = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(mapped) ? mapped : null;
}

async function dockerImageExists(image: string) {
  const result = await execDocker(["image", "inspect", image], {
    allowFailure: true,
  });
  return result.code === 0;
}

async function ensureDockerImage(image: string) {
  const exists = await dockerImageExists(image);
  if (exists) return;
  if (image === DEFAULT_SANDBOX_IMAGE) {
    await execDocker(["pull", "debian:bookworm-slim"]);
    await execDocker(["tag", "debian:bookworm-slim", DEFAULT_SANDBOX_IMAGE]);
    return;
  }
  throw new Error(`Sandbox image not found: ${image}. Build or pull it first.`);
}

async function dockerContainerState(name: string) {
  const result = await execDocker(
    ["inspect", "-f", "{{.State.Running}}", name],
    { allowFailure: true },
  );
  if (result.code !== 0) return { exists: false, running: false };
  return { exists: true, running: result.stdout.trim() === "true" };
}

async function ensureSandboxWorkspace(workspaceDir: string, seedFrom?: string) {
  await fs.mkdir(workspaceDir, { recursive: true });
  if (seedFrom) {
    const seed = resolveUserPath(seedFrom);
    const files = [
      DEFAULT_AGENTS_FILENAME,
      DEFAULT_SOUL_FILENAME,
      DEFAULT_TOOLS_FILENAME,
      DEFAULT_IDENTITY_FILENAME,
      DEFAULT_USER_FILENAME,
      DEFAULT_BOOTSTRAP_FILENAME,
    ];
    for (const name of files) {
      const src = path.join(seed, name);
      const dest = path.join(workspaceDir, name);
      try {
        await fs.access(dest);
      } catch {
        try {
          const content = await fs.readFile(src, "utf-8");
          await fs.writeFile(dest, content, { encoding: "utf-8", flag: "wx" });
        } catch {
          // ignore missing seed file
        }
      }
    }
  }
  await ensureAgentWorkspace({ dir: workspaceDir, ensureBootstrapFiles: true });
}

async function createSandboxContainer(params: {
  name: string;
  cfg: SandboxDockerConfig;
  workspaceDir: string;
  sessionKey: string;
}) {
  const { name, cfg, workspaceDir, sessionKey } = params;
  await ensureDockerImage(cfg.image);

  const args = ["create", "--name", name];
  args.push("--label", "clawdis.sandbox=1");
  args.push("--label", `clawdis.sessionKey=${sessionKey}`);
  args.push("--label", `clawdis.createdAtMs=${Date.now()}`);
  if (cfg.readOnlyRoot) args.push("--read-only");
  for (const entry of cfg.tmpfs) {
    args.push("--tmpfs", entry);
  }
  if (cfg.network) args.push("--network", cfg.network);
  if (cfg.user) args.push("--user", cfg.user);
  for (const cap of cfg.capDrop) {
    args.push("--cap-drop", cap);
  }
  args.push("--security-opt", "no-new-privileges");
  args.push("--workdir", cfg.workdir);
  args.push("-v", `${workspaceDir}:${cfg.workdir}`);
  args.push(cfg.image, "sleep", "infinity");

  await execDocker(args);
  await execDocker(["start", name]);

  if (cfg.setupCommand?.trim()) {
    await execDocker(["exec", "-i", name, "sh", "-lc", cfg.setupCommand]);
  }
}

async function ensureSandboxContainer(params: {
  sessionKey: string;
  workspaceDir: string;
  cfg: SandboxConfig;
}) {
  const slug = params.cfg.perSession
    ? slugifySessionKey(params.sessionKey)
    : "shared";
  const name = `${params.cfg.docker.containerPrefix}${slug}`;
  const containerName = name.slice(0, 63);
  const state = await dockerContainerState(containerName);
  if (!state.exists) {
    await createSandboxContainer({
      name: containerName,
      cfg: params.cfg.docker,
      workspaceDir: params.workspaceDir,
      sessionKey: params.sessionKey,
    });
  } else if (!state.running) {
    await execDocker(["start", containerName]);
  }
  const now = Date.now();
  await updateRegistry({
    containerName,
    sessionKey: params.sessionKey,
    createdAtMs: now,
    lastUsedAtMs: now,
    image: params.cfg.docker.image,
  });
  return containerName;
}

async function ensureSandboxBrowserImage(image: string) {
  const exists = await dockerImageExists(image);
  if (exists) return;
  throw new Error(
    `Sandbox browser image not found: ${image}. Build it with scripts/sandbox-browser-setup.sh.`,
  );
}

function buildSandboxBrowserResolvedConfig(params: {
  controlPort: number;
  cdpPort: number;
  headless: boolean;
}): ResolvedBrowserConfig {
  const controlHost = "127.0.0.1";
  const controlUrl = `http://${controlHost}:${params.controlPort}`;
  const cdpHost = "127.0.0.1";
  const cdpUrl = `http://${cdpHost}:${params.cdpPort}`;
  return {
    enabled: true,
    controlUrl,
    controlHost,
    controlPort: params.controlPort,
    cdpUrl,
    cdpHost,
    cdpPort: params.cdpPort,
    cdpIsLoopback: true,
    color: DEFAULT_CLAWD_BROWSER_COLOR,
    executablePath: undefined,
    headless: params.headless,
    noSandbox: false,
    attachOnly: true,
  };
}

async function ensureSandboxBrowser(params: {
  sessionKey: string;
  workspaceDir: string;
  cfg: SandboxConfig;
}): Promise<SandboxBrowserContext | null> {
  if (!params.cfg.browser.enabled) return null;
  if (!isToolAllowed(params.cfg.tools, "browser")) return null;

  const slug = params.cfg.perSession
    ? slugifySessionKey(params.sessionKey)
    : "shared";
  const name = `${params.cfg.browser.containerPrefix}${slug}`;
  const containerName = name.slice(0, 63);
  const state = await dockerContainerState(containerName);
  if (!state.exists) {
    await ensureSandboxBrowserImage(params.cfg.browser.image);
    const args = ["create", "--name", containerName];
    args.push("--label", "clawdis.sandbox=1");
    args.push("--label", "clawdis.sandboxBrowser=1");
    args.push("--label", `clawdis.sessionKey=${params.sessionKey}`);
    args.push("--label", `clawdis.createdAtMs=${Date.now()}`);
    if (params.cfg.docker.readOnlyRoot) args.push("--read-only");
    for (const entry of params.cfg.docker.tmpfs) {
      args.push("--tmpfs", entry);
    }
    if (params.cfg.docker.network)
      args.push("--network", params.cfg.docker.network);
    if (params.cfg.docker.user) args.push("--user", params.cfg.docker.user);
    for (const cap of params.cfg.docker.capDrop) {
      args.push("--cap-drop", cap);
    }
    args.push("--security-opt", "no-new-privileges");
    args.push("-v", `${params.workspaceDir}:${params.cfg.docker.workdir}`);
    args.push("-p", `127.0.0.1::${params.cfg.browser.cdpPort}`);
    if (params.cfg.browser.enableNoVnc && !params.cfg.browser.headless) {
      args.push("-p", `127.0.0.1::${params.cfg.browser.noVncPort}`);
    }
    args.push(
      "-e",
      `CLAWDIS_BROWSER_HEADLESS=${params.cfg.browser.headless ? "1" : "0"}`,
    );
    args.push(
      "-e",
      `CLAWDIS_BROWSER_ENABLE_NOVNC=${
        params.cfg.browser.enableNoVnc ? "1" : "0"
      }`,
    );
    args.push("-e", `CLAWDIS_BROWSER_CDP_PORT=${params.cfg.browser.cdpPort}`);
    args.push("-e", `CLAWDIS_BROWSER_VNC_PORT=${params.cfg.browser.vncPort}`);
    args.push(
      "-e",
      `CLAWDIS_BROWSER_NOVNC_PORT=${params.cfg.browser.noVncPort}`,
    );
    args.push(params.cfg.browser.image);
    await execDocker(args);
    await execDocker(["start", containerName]);
  } else if (!state.running) {
    await execDocker(["start", containerName]);
  }

  const mappedCdp = await readDockerPort(
    containerName,
    params.cfg.browser.cdpPort,
  );
  if (!mappedCdp) {
    throw new Error(`Failed to resolve CDP port mapping for ${containerName}.`);
  }

  const mappedNoVnc =
    params.cfg.browser.enableNoVnc && !params.cfg.browser.headless
      ? await readDockerPort(containerName, params.cfg.browser.noVncPort)
      : null;

  const existing = BROWSER_BRIDGES.get(params.sessionKey);
  const shouldReuse =
    existing &&
    existing.containerName === containerName &&
    existing.bridge.state.resolved.cdpPort === mappedCdp;
  if (existing && !shouldReuse) {
    await stopBrowserBridgeServer(existing.bridge.server).catch(
      () => undefined,
    );
    BROWSER_BRIDGES.delete(params.sessionKey);
  }
  let bridge: BrowserBridge;
  if (shouldReuse && existing) {
    bridge = existing.bridge;
  } else {
    bridge = await startBrowserBridgeServer({
      resolved: buildSandboxBrowserResolvedConfig({
        controlPort: 0,
        cdpPort: mappedCdp,
        headless: params.cfg.browser.headless,
      }),
    });
  }
  if (!shouldReuse) {
    BROWSER_BRIDGES.set(params.sessionKey, { bridge, containerName });
  }

  const now = Date.now();
  await updateBrowserRegistry({
    containerName,
    sessionKey: params.sessionKey,
    createdAtMs: now,
    lastUsedAtMs: now,
    image: params.cfg.browser.image,
    cdpPort: mappedCdp,
    noVncPort: mappedNoVnc ?? undefined,
  });

  const noVncUrl =
    mappedNoVnc &&
    params.cfg.browser.enableNoVnc &&
    !params.cfg.browser.headless
      ? `http://127.0.0.1:${mappedNoVnc}/vnc.html?autoconnect=1&resize=remote`
      : undefined;

  return {
    controlUrl: bridge.baseUrl,
    noVncUrl,
    containerName,
  };
}

async function pruneSandboxContainers(cfg: SandboxConfig) {
  const now = Date.now();
  const idleHours = cfg.prune.idleHours;
  const maxAgeDays = cfg.prune.maxAgeDays;
  if (idleHours === 0 && maxAgeDays === 0) return;
  const registry = await readRegistry();
  for (const entry of registry.entries) {
    const idleMs = now - entry.lastUsedAtMs;
    const ageMs = now - entry.createdAtMs;
    if (
      (idleHours > 0 && idleMs > idleHours * 60 * 60 * 1000) ||
      (maxAgeDays > 0 && ageMs > maxAgeDays * 24 * 60 * 60 * 1000)
    ) {
      try {
        await execDocker(["rm", "-f", entry.containerName], {
          allowFailure: true,
        });
      } catch {
        // ignore prune failures
      } finally {
        await removeRegistryEntry(entry.containerName);
      }
    }
  }
}

async function pruneSandboxBrowsers(cfg: SandboxConfig) {
  const now = Date.now();
  const idleHours = cfg.prune.idleHours;
  const maxAgeDays = cfg.prune.maxAgeDays;
  if (idleHours === 0 && maxAgeDays === 0) return;
  const registry = await readBrowserRegistry();
  for (const entry of registry.entries) {
    const idleMs = now - entry.lastUsedAtMs;
    const ageMs = now - entry.createdAtMs;
    if (
      (idleHours > 0 && idleMs > idleHours * 60 * 60 * 1000) ||
      (maxAgeDays > 0 && ageMs > maxAgeDays * 24 * 60 * 60 * 1000)
    ) {
      try {
        await execDocker(["rm", "-f", entry.containerName], {
          allowFailure: true,
        });
      } catch {
        // ignore prune failures
      } finally {
        await removeBrowserRegistryEntry(entry.containerName);
        const bridge = BROWSER_BRIDGES.get(entry.sessionKey);
        if (bridge?.containerName === entry.containerName) {
          await stopBrowserBridgeServer(bridge.bridge.server).catch(
            () => undefined,
          );
          BROWSER_BRIDGES.delete(entry.sessionKey);
        }
      }
    }
  }
}

async function maybePruneSandboxes(cfg: SandboxConfig) {
  const now = Date.now();
  if (now - lastPruneAtMs < 5 * 60 * 1000) return;
  lastPruneAtMs = now;
  try {
    await pruneSandboxContainers(cfg);
    await pruneSandboxBrowsers(cfg);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : JSON.stringify(error);
    defaultRuntime.error?.(
      `Sandbox prune failed: ${message ?? "unknown error"}`,
    );
  }
}

export async function resolveSandboxContext(params: {
  config?: ClawdisConfig;
  sessionKey?: string;
  workspaceDir?: string;
}): Promise<SandboxContext | null> {
  const rawSessionKey = params.sessionKey?.trim();
  if (!rawSessionKey) return null;
  const cfg = defaultSandboxConfig(params.config);
  const mainKey = params.config?.session?.mainKey?.trim() || "main";
  if (!shouldSandboxSession(cfg, rawSessionKey, mainKey)) return null;

  await maybePruneSandboxes(cfg);

  const workspaceRoot = resolveUserPath(cfg.workspaceRoot);
  const workspaceDir = cfg.perSession
    ? resolveSandboxWorkspaceDir(workspaceRoot, rawSessionKey)
    : workspaceRoot;
  const seedWorkspace =
    params.workspaceDir?.trim() || DEFAULT_AGENT_WORKSPACE_DIR;
  await ensureSandboxWorkspace(workspaceDir, seedWorkspace);

  const containerName = await ensureSandboxContainer({
    sessionKey: rawSessionKey,
    workspaceDir,
    cfg,
  });

  const browser = await ensureSandboxBrowser({
    sessionKey: rawSessionKey,
    workspaceDir,
    cfg,
  });

  return {
    enabled: true,
    sessionKey: rawSessionKey,
    workspaceDir,
    containerName,
    containerWorkdir: cfg.docker.workdir,
    docker: cfg.docker,
    tools: cfg.tools,
    browser: browser ?? undefined,
  };
}
