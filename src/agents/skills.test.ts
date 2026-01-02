import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  applySkillEnvOverrides,
  applySkillEnvOverridesFromSnapshot,
  buildWorkspaceSkillSnapshot,
  buildWorkspaceSkillsPrompt,
  loadWorkspaceSkillEntries,
} from "./skills.js";
import { buildWorkspaceSkillStatus } from "./skills-status.js";

async function writeSkill(params: {
  dir: string;
  name: string;
  description: string;
  metadata?: string;
  body?: string;
}) {
  const { dir, name, description, metadata, body } = params;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "SKILL.md"),
    `---
name: ${name}
description: ${description}${metadata ? `\nmetadata: ${metadata}` : ""}
---

${body ?? `# ${name}\n`}
`,
    "utf-8",
  );
}

describe("buildWorkspaceSkillsPrompt", () => {
  it("returns empty prompt when skills dirs are missing", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdis-"));

    const prompt = buildWorkspaceSkillsPrompt(workspaceDir, {
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      bundledSkillsDir: path.join(workspaceDir, ".bundled"),
    });

    expect(prompt).toBe("");
  });

  it("loads bundled skills when present", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdis-"));
    const bundledDir = path.join(workspaceDir, ".bundled");
    const bundledSkillDir = path.join(bundledDir, "peekaboo");

    await writeSkill({
      dir: bundledSkillDir,
      name: "peekaboo",
      description: "Capture UI",
      body: "# Peekaboo\n",
    });

    const prompt = buildWorkspaceSkillsPrompt(workspaceDir, {
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      bundledSkillsDir: bundledDir,
    });
    expect(prompt).toContain("peekaboo");
    expect(prompt).toContain("Capture UI");
    expect(prompt).toContain(path.join(bundledSkillDir, "SKILL.md"));
  });

  it("loads extra skill folders from config (lowest precedence)", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdis-"));
    const extraDir = path.join(workspaceDir, ".extra");
    const bundledDir = path.join(workspaceDir, ".bundled");
    const managedDir = path.join(workspaceDir, ".managed");

    await writeSkill({
      dir: path.join(extraDir, "demo-skill"),
      name: "demo-skill",
      description: "Extra version",
      body: "# Extra\n",
    });
    await writeSkill({
      dir: path.join(bundledDir, "demo-skill"),
      name: "demo-skill",
      description: "Bundled version",
      body: "# Bundled\n",
    });
    await writeSkill({
      dir: path.join(managedDir, "demo-skill"),
      name: "demo-skill",
      description: "Managed version",
      body: "# Managed\n",
    });
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "demo-skill"),
      name: "demo-skill",
      description: "Workspace version",
      body: "# Workspace\n",
    });

    const prompt = buildWorkspaceSkillsPrompt(workspaceDir, {
      bundledSkillsDir: bundledDir,
      managedSkillsDir: managedDir,
      config: { skillsLoad: { extraDirs: [extraDir] } },
    });

    expect(prompt).toContain("Workspace version");
    expect(prompt).not.toContain("Managed version");
    expect(prompt).not.toContain("Bundled version");
    expect(prompt).not.toContain("Extra version");
  });

  it("loads skills from workspace skills/", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdis-"));
    const skillDir = path.join(workspaceDir, "skills", "demo-skill");

    await writeSkill({
      dir: skillDir,
      name: "demo-skill",
      description: "Does demo things",
      body: "# Demo Skill\n",
    });

    const prompt = buildWorkspaceSkillsPrompt(workspaceDir, {
      managedSkillsDir: path.join(workspaceDir, ".managed"),
    });
    expect(prompt).toContain("demo-skill");
    expect(prompt).toContain("Does demo things");
    expect(prompt).toContain(path.join(skillDir, "SKILL.md"));
  });

  it("filters skills based on env/config gates", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdis-"));
    const skillDir = path.join(workspaceDir, "skills", "nano-banana-pro");
    const originalEnv = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;

    try {
      await writeSkill({
        dir: skillDir,
        name: "nano-banana-pro",
        description: "Generates images",
        metadata:
          '{"clawdis":{"requires":{"env":["GEMINI_API_KEY"]},"primaryEnv":"GEMINI_API_KEY"}}',
        body: "# Nano Banana\n",
      });

      const missingPrompt = buildWorkspaceSkillsPrompt(workspaceDir, {
        managedSkillsDir: path.join(workspaceDir, ".managed"),
        config: { skills: { "nano-banana-pro": { apiKey: "" } } },
      });
      expect(missingPrompt).not.toContain("nano-banana-pro");

      const enabledPrompt = buildWorkspaceSkillsPrompt(workspaceDir, {
        managedSkillsDir: path.join(workspaceDir, ".managed"),
        config: { skills: { "nano-banana-pro": { apiKey: "test-key" } } },
      });
      expect(enabledPrompt).toContain("nano-banana-pro");
    } finally {
      if (originalEnv === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = originalEnv;
    }
  });

  it("prefers workspace skills over managed skills", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdis-"));
    const managedDir = path.join(workspaceDir, ".managed");
    const bundledDir = path.join(workspaceDir, ".bundled");
    const managedSkillDir = path.join(managedDir, "demo-skill");
    const bundledSkillDir = path.join(bundledDir, "demo-skill");
    const workspaceSkillDir = path.join(workspaceDir, "skills", "demo-skill");

    await writeSkill({
      dir: bundledSkillDir,
      name: "demo-skill",
      description: "Bundled version",
      body: "# Bundled\n",
    });
    await writeSkill({
      dir: managedSkillDir,
      name: "demo-skill",
      description: "Managed version",
      body: "# Managed\n",
    });
    await writeSkill({
      dir: workspaceSkillDir,
      name: "demo-skill",
      description: "Workspace version",
      body: "# Workspace\n",
    });

    const prompt = buildWorkspaceSkillsPrompt(workspaceDir, {
      managedSkillsDir: managedDir,
      bundledSkillsDir: bundledDir,
    });

    expect(prompt).toContain("Workspace version");
    expect(prompt).toContain(path.join(workspaceSkillDir, "SKILL.md"));
    expect(prompt).not.toContain(path.join(managedSkillDir, "SKILL.md"));
    expect(prompt).not.toContain(path.join(bundledSkillDir, "SKILL.md"));
  });

  it("gates by bins, config, and always", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdis-"));
    const skillsDir = path.join(workspaceDir, "skills");
    const binDir = path.join(workspaceDir, "bin");
    const originalPath = process.env.PATH;

    await writeSkill({
      dir: path.join(skillsDir, "bin-skill"),
      name: "bin-skill",
      description: "Needs a bin",
      metadata: '{"clawdis":{"requires":{"bins":["fakebin"]}}}',
    });
    await writeSkill({
      dir: path.join(skillsDir, "anybin-skill"),
      name: "anybin-skill",
      description: "Needs any bin",
      metadata: '{"clawdis":{"requires":{"anyBins":["missingbin","fakebin"]}}}',
    });
    await writeSkill({
      dir: path.join(skillsDir, "config-skill"),
      name: "config-skill",
      description: "Needs config",
      metadata: '{"clawdis":{"requires":{"config":["browser.enabled"]}}}',
    });
    await writeSkill({
      dir: path.join(skillsDir, "always-skill"),
      name: "always-skill",
      description: "Always on",
      metadata: '{"clawdis":{"always":true,"requires":{"env":["MISSING"]}}}',
    });
    await writeSkill({
      dir: path.join(skillsDir, "env-skill"),
      name: "env-skill",
      description: "Needs env",
      metadata:
        '{"clawdis":{"requires":{"env":["ENV_KEY"]},"primaryEnv":"ENV_KEY"}}',
    });

    try {
      const defaultPrompt = buildWorkspaceSkillsPrompt(workspaceDir, {
        managedSkillsDir: path.join(workspaceDir, ".managed"),
      });
      expect(defaultPrompt).toContain("always-skill");
      expect(defaultPrompt).toContain("config-skill");
      expect(defaultPrompt).not.toContain("bin-skill");
      expect(defaultPrompt).not.toContain("anybin-skill");
      expect(defaultPrompt).not.toContain("env-skill");

      await fs.mkdir(binDir, { recursive: true });
      const fakebinPath = path.join(binDir, "fakebin");
      await fs.writeFile(fakebinPath, "#!/bin/sh\nexit 0\n", "utf-8");
      await fs.chmod(fakebinPath, 0o755);
      process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;

      const gatedPrompt = buildWorkspaceSkillsPrompt(workspaceDir, {
        managedSkillsDir: path.join(workspaceDir, ".managed"),
        config: {
          browser: { enabled: false },
          skills: { "env-skill": { apiKey: "ok" } },
        },
      });
      expect(gatedPrompt).toContain("bin-skill");
      expect(gatedPrompt).toContain("anybin-skill");
      expect(gatedPrompt).toContain("env-skill");
      expect(gatedPrompt).toContain("always-skill");
      expect(gatedPrompt).not.toContain("config-skill");
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("uses skillKey for config lookups", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdis-"));
    const skillDir = path.join(workspaceDir, "skills", "alias-skill");
    await writeSkill({
      dir: skillDir,
      name: "alias-skill",
      description: "Uses skillKey",
      metadata: '{"clawdis":{"skillKey":"alias"}}',
    });

    const prompt = buildWorkspaceSkillsPrompt(workspaceDir, {
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      config: { skills: { alias: { enabled: false } } },
    });
    expect(prompt).not.toContain("alias-skill");
  });
});

describe("loadWorkspaceSkillEntries", () => {
  it("handles an empty managed skills dir without throwing", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdis-"));
    const managedDir = path.join(workspaceDir, ".managed");
    await fs.mkdir(managedDir, { recursive: true });

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      managedSkillsDir: managedDir,
      bundledSkillsDir: path.join(workspaceDir, ".bundled"),
    });

    expect(entries).toEqual([]);
  });
});

describe("buildWorkspaceSkillSnapshot", () => {
  it("returns an empty snapshot when skills dirs are missing", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdis-"));

    const snapshot = buildWorkspaceSkillSnapshot(workspaceDir, {
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      bundledSkillsDir: path.join(workspaceDir, ".bundled"),
    });

    expect(snapshot.prompt).toBe("");
    expect(snapshot.skills).toEqual([]);
  });
});

describe("buildWorkspaceSkillStatus", () => {
  it("reports missing requirements and install options", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdis-"));
    const skillDir = path.join(workspaceDir, "skills", "status-skill");

    await writeSkill({
      dir: skillDir,
      name: "status-skill",
      description: "Needs setup",
      metadata:
        '{"clawdis":{"requires":{"bins":["fakebin"],"env":["ENV_KEY"],"config":["browser.enabled"]},"install":[{"id":"brew","kind":"brew","formula":"fakebin","bins":["fakebin"],"label":"Install fakebin"}]}}',
    });

    const report = buildWorkspaceSkillStatus(workspaceDir, {
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      config: { browser: { enabled: false } },
    });
    const skill = report.skills.find((entry) => entry.name === "status-skill");

    expect(skill).toBeDefined();
    expect(skill?.eligible).toBe(false);
    expect(skill?.missing.bins).toContain("fakebin");
    expect(skill?.missing.env).toContain("ENV_KEY");
    expect(skill?.missing.config).toContain("browser.enabled");
    expect(skill?.install[0]?.id).toBe("brew");
  });
});

describe("applySkillEnvOverrides", () => {
  it("sets and restores env vars", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdis-"));
    const skillDir = path.join(workspaceDir, "skills", "env-skill");
    await writeSkill({
      dir: skillDir,
      name: "env-skill",
      description: "Needs env",
      metadata:
        '{"clawdis":{"requires":{"env":["ENV_KEY"]},"primaryEnv":"ENV_KEY"}}',
    });

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      managedSkillsDir: path.join(workspaceDir, ".managed"),
    });

    const originalEnv = process.env.ENV_KEY;
    delete process.env.ENV_KEY;

    const restore = applySkillEnvOverrides({
      skills: entries,
      config: { skills: { "env-skill": { apiKey: "injected" } } },
    });

    try {
      expect(process.env.ENV_KEY).toBe("injected");
    } finally {
      restore();
      if (originalEnv === undefined) {
        expect(process.env.ENV_KEY).toBeUndefined();
      } else {
        expect(process.env.ENV_KEY).toBe(originalEnv);
      }
    }
  });

  it("applies env overrides from snapshots", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdis-"));
    const skillDir = path.join(workspaceDir, "skills", "env-skill");
    await writeSkill({
      dir: skillDir,
      name: "env-skill",
      description: "Needs env",
      metadata:
        '{"clawdis":{"requires":{"env":["ENV_KEY"]},"primaryEnv":"ENV_KEY"}}',
    });

    const snapshot = buildWorkspaceSkillSnapshot(workspaceDir, {
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      config: { skills: { "env-skill": { apiKey: "snap-key" } } },
    });

    const originalEnv = process.env.ENV_KEY;
    delete process.env.ENV_KEY;

    const restore = applySkillEnvOverridesFromSnapshot({
      snapshot,
      config: { skills: { "env-skill": { apiKey: "snap-key" } } },
    });

    try {
      expect(process.env.ENV_KEY).toBe("snap-key");
    } finally {
      restore();
      if (originalEnv === undefined) {
        expect(process.env.ENV_KEY).toBeUndefined();
      } else {
        expect(process.env.ENV_KEY).toBe(originalEnv);
      }
    }
  });
});
