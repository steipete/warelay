import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { setVerbose } from "./globals.js";
import { logDebug, logError, logInfo, logSuccess, logWarn } from "./logger.js";
import { resetLogger, setLoggerOverride } from "./logging.js";
import type { RuntimeEnv } from "./runtime.js";

describe("logger helpers", () => {
	afterEach(() => {
		resetLogger();
		setLoggerOverride(null);
		setVerbose(false);
	});

	it("formats messages through runtime log/error", () => {
		const log = vi.fn();
		const error = vi.fn();
		const runtime: RuntimeEnv = { log, error, exit: vi.fn() };

		logInfo("info", runtime);
		logWarn("warn", runtime);
		logSuccess("ok", runtime);
		logError("bad", runtime);

		expect(log).toHaveBeenCalledTimes(3);
		expect(error).toHaveBeenCalledTimes(1);
	});

	it("only logs debug when verbose is enabled", () => {
		const logVerbose = vi.spyOn(console, "log");
		setVerbose(false);
		logDebug("quiet");
		expect(logVerbose).not.toHaveBeenCalled();

		setVerbose(true);
		logVerbose.mockClear();
		logDebug("loud");
		expect(logVerbose).toHaveBeenCalled();
		logVerbose.mockRestore();
	});

	it("writes to configured log file at configured level", () => {
		const logPath = pathForTest();
		cleanup(logPath);
		setLoggerOverride({ level: "debug", file: logPath });
		logInfo("hello");
		logDebug("debug-only");
		const content = fs.readFileSync(logPath, "utf-8");
		expect(content).toContain("hello");
		expect(content).toContain("debug-only");
		cleanup(logPath);
	});

	it("filters messages below configured level", () => {
		const logPath = pathForTest();
		cleanup(logPath);
		setLoggerOverride({ level: "warn", file: logPath });
		logInfo("info-only");
		logWarn("warn-only");
		const content = fs.readFileSync(logPath, "utf-8");
		expect(content).not.toContain("info-only");
		expect(content).toContain("warn-only");
		cleanup(logPath);
	});
});

function pathForTest() {
	return path.join(os.tmpdir(), `warelay-log-${crypto.randomUUID()}.log`);
}

function cleanup(file: string) {
	try {
		fs.rmSync(file, { force: true });
	} catch {
		// ignore
	}
}
