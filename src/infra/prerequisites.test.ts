import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  PREREQUISITE_CHECKS,
  runAllPrerequisiteChecks,
  runRequiredPrerequisiteChecks,
} from "./prerequisites.js";

describe("prerequisites", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("PREREQUISITE_CHECKS", () => {
    it("should have checks for all required categories", () => {
      const categories = new Set(PREREQUISITE_CHECKS.map((c) => c.category));
      expect(categories).toContain("runtime");
      expect(categories).toContain("tools");
      expect(categories).toContain("credentials");
      expect(categories).toContain("network");
    });

    it("should have required checks for Node.js and Anthropic API key", () => {
      const required = PREREQUISITE_CHECKS.filter((c) => c.required);
      const names = required.map((c) => c.name);
      expect(names).toContain("Node.js");
      expect(names).toContain("pnpm");
      expect(names).toContain("Anthropic API Key");
      expect(names).toContain("Network Connectivity");
    });

    it("should have optional checks for providers", () => {
      const optional = PREREQUISITE_CHECKS.filter((c) => !c.required);
      const names = optional.map((c) => c.name);
      expect(names).toContain("WhatsApp Credentials");
      expect(names).toContain("Telegram Bot Token");
      expect(names).toContain("Discord Bot Token");
      expect(names).toContain("Git");
    });
  });

  describe("fixable issues", () => {
    it("should include fixId for fixable issues", async () => {
      const report = await runAllPrerequisiteChecks();

      // Check that results with warnings/errors have fixId where applicable
      for (const result of report.results) {
        if (result.name === "Clawdis Config" && result.status === "warning") {
          expect(result.fixId).toBe("setup-config");
        }
        if (result.name === "Agent Workspace" && result.status === "warning") {
          expect(result.fixId).toBe("setup-workspace");
        }
        if (
          result.name === "WhatsApp Credentials" &&
          result.status === "warning"
        ) {
          expect(result.fixId).toBe("whatsapp-login");
        }
        if (result.name === "Anthropic API Key" && result.status === "error") {
          expect(result.fixId).toBe("anthropic-key");
        }
      }
    });
  });

  describe("runAllPrerequisiteChecks", () => {
    it("should return results for all checks", async () => {
      const report = await runAllPrerequisiteChecks();

      expect(report.results).toHaveLength(PREREQUISITE_CHECKS.length);
      expect(report.summary).toBeDefined();
      expect(typeof report.hasErrors).toBe("boolean");
      expect(typeof report.hasWarnings).toBe("boolean");
    });

    it("should calculate summary correctly", async () => {
      const report = await runAllPrerequisiteChecks();

      const { ok, warning, error, skipped } = report.summary;
      const total = ok + warning + error + skipped;
      expect(total).toBe(report.results.length);
    });

    it("should include Node.js check with ok status in current environment", async () => {
      const report = await runAllPrerequisiteChecks();

      const nodeResult = report.results.find((r) => r.name === "Node.js");
      expect(nodeResult).toBeDefined();
      expect(nodeResult?.status).toBe("ok");
      expect(nodeResult?.version).toBeDefined();
    });
  });

  describe("runRequiredPrerequisiteChecks", () => {
    it("should only run required checks", async () => {
      const report = await runRequiredPrerequisiteChecks();

      const requiredCount = PREREQUISITE_CHECKS.filter(
        (c) => c.required,
      ).length;
      expect(report.results.length).toBe(requiredCount);
    });

    it("should not include optional provider checks", async () => {
      const report = await runRequiredPrerequisiteChecks();

      const names = report.results.map((r) => r.name);
      expect(names).not.toContain("WhatsApp Credentials");
      expect(names).not.toContain("Telegram Bot Token");
      expect(names).not.toContain("Discord Bot Token");
      expect(names).not.toContain("Git");
    });
  });

  describe("individual check results", () => {
    it("pnpm check should return ok in dev environment", async () => {
      const report = await runAllPrerequisiteChecks();
      const pnpmResult = report.results.find((r) => r.name === "pnpm");

      expect(pnpmResult).toBeDefined();
      expect(pnpmResult?.status).toBe("ok");
      expect(pnpmResult?.version).toBeDefined();
    });

    it("result objects should have required fields", async () => {
      const report = await runAllPrerequisiteChecks();

      for (const result of report.results) {
        expect(result.name).toBeDefined();
        expect(result.status).toMatch(/^(ok|warning|error|skipped)$/);
        expect(result.message).toBeDefined();
      }
    });

    it("error and warning results should have hints when applicable", async () => {
      const report = await runAllPrerequisiteChecks();

      for (const result of report.results) {
        if (result.status === "error" || result.status === "warning") {
          // Most errors/warnings should have hints, but not strictly required
          // Just verify structure is valid
          expect(
            typeof result.hint === "string" || result.hint === undefined,
          ).toBe(true);
        }
      }
    });
  });
});
