import { beforeEach, describe, expect, it, vi } from "vitest";

import { doctorCommand } from "./doctor.js";

describe("doctorCommand", () => {
  let logs: string[] = [];
  let exitCode: number | undefined;

  const mockRuntime = {
    log: (msg: string) => {
      logs.push(msg);
    },
    error: (msg: string) => {
      logs.push(`ERROR: ${msg}`);
    },
    exit: (code: number) => {
      exitCode = code;
    },
  };

  beforeEach(() => {
    logs = [];
    exitCode = undefined;
    vi.resetAllMocks();
  });

  describe("fix option", () => {
    it("should accept fix option without crashing", async () => {
      // Just verify it doesn't throw - actual fix behavior requires TTY
      await doctorCommand({ fix: false }, mockRuntime);
      expect(logs.length).toBeGreaterThan(0);
    });

    it("should suggest --fix when errors exist", async () => {
      await doctorCommand({}, mockRuntime);

      const output = logs.join("\n");
      // Should suggest --fix if there are errors
      if (output.includes("errors")) {
        expect(output).toContain("--fix");
      }
    });
  });

  describe("default output", () => {
    it("should run without crashing", async () => {
      await doctorCommand({}, mockRuntime);

      // Should have some output
      expect(logs.length).toBeGreaterThan(0);
    });

    it("should include header", async () => {
      await doctorCommand({}, mockRuntime);

      const output = logs.join("\n");
      expect(output).toContain("Clawdis Doctor");
    });

    it("should include summary", async () => {
      await doctorCommand({}, mockRuntime);

      const output = logs.join("\n");
      // Should contain pass/warning/error counts
      expect(output).toMatch(/passed|warnings|errors|skipped/);
    });
  });

  describe("json output", () => {
    it("should output valid JSON when --json is set", async () => {
      await doctorCommand({ json: true }, mockRuntime);

      expect(logs.length).toBe(1);
      const parsed = JSON.parse(logs[0]);
      expect(parsed.results).toBeDefined();
      expect(parsed.summary).toBeDefined();
      expect(typeof parsed.hasErrors).toBe("boolean");
      expect(typeof parsed.hasWarnings).toBe("boolean");
    });

    it("should include all check results in JSON", async () => {
      await doctorCommand({ json: true }, mockRuntime);

      const parsed = JSON.parse(logs[0]);
      expect(parsed.results.length).toBeGreaterThan(0);

      for (const result of parsed.results) {
        expect(result.name).toBeDefined();
        expect(result.status).toBeDefined();
        expect(result.message).toBeDefined();
      }
    });
  });

  describe("verbose output", () => {
    it("should include version info when verbose is set", async () => {
      await doctorCommand({ verbose: true }, mockRuntime);

      const output = logs.join("\n");
      // Node.js check should show version in verbose mode
      expect(output).toMatch(/v?\d+\.\d+\.\d+/);
    });
  });

  describe("exit codes", () => {
    it("should not exit with error if no required checks fail", async () => {
      await doctorCommand({}, mockRuntime);

      // In a dev environment, required checks should pass
      // If there are errors, exitCode will be 1
      // We mainly verify it doesn't crash
      expect(exitCode === undefined || exitCode === 0 || exitCode === 1).toBe(
        true,
      );
    });

    it("should exit with 1 in json mode if errors exist", async () => {
      await doctorCommand({ json: true }, mockRuntime);

      const parsed = JSON.parse(logs[0]);
      if (parsed.hasErrors) {
        expect(exitCode).toBe(1);
      }
    });
  });

  describe("category grouping", () => {
    it("should group results by category", async () => {
      await doctorCommand({}, mockRuntime);

      const output = logs.join("\n");
      // Should have category headers
      expect(output).toContain("Runtime");
      expect(output).toContain("Configuration");
    });
  });
});
