import { describe, expect, it, vi } from "vitest";

import type { CliDeps } from "../cli/deps.js";
import type { RuntimeEnv } from "../runtime.js";
import { statusCommand } from "./status.js";

vi.mock("../twilio/messages.js", () => ({
	formatMessageLine: (m: any) => `LINE:${m.sid}`,
}));

const runtime: RuntimeEnv = {
	log: vi.fn(),
	error: vi.fn(),
	exit: vi.fn(() => {
		throw new Error("exit");
	}),
};

const deps: CliDeps = {
	listRecentMessages: vi.fn(),
} as unknown as CliDeps;

describe("statusCommand", () => {
	it("validates limit and lookback", async () => {
		await expect(
			statusCommand({ limit: "0", lookback: "10" }, deps, runtime),
		).rejects.toThrow("limit must be between 1 and 200");
		await expect(
			statusCommand({ limit: "10", lookback: "0" }, deps, runtime),
		).rejects.toThrow("lookback must be > 0 minutes");
	});

	it("prints JSON when requested", async () => {
		(deps.listRecentMessages as any).mockResolvedValue([{ sid: "1" }]);
		await statusCommand(
			{ limit: "5", lookback: "10", json: true },
			deps,
			runtime,
		);
		expect(runtime.log).toHaveBeenCalledWith(
			JSON.stringify([{ sid: "1" }], null, 2),
		);
	});

	it("prints formatted lines otherwise", async () => {
		(deps.listRecentMessages as any).mockResolvedValue([{ sid: "123" }]);
		await statusCommand({ limit: "1", lookback: "5" }, deps, runtime);
		expect(runtime.log).toHaveBeenCalledWith("LINE:123");
	});
});
