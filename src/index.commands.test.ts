import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockTwilio } from "../test/mocks/twilio.js";
import { statusCommand } from "./commands/status.js";
import { createDefaultDeps, defaultRuntime } from "./index.js";

vi.mock("twilio", () => {
	const { factory } = createMockTwilio();
	return { default: factory };
});

import * as index from "./index.js";
import * as provider from "./provider-web.js";

beforeEach(() => {
	index.program.exitOverride();
	process.env.TWILIO_ACCOUNT_SID = "AC123";
	process.env.TWILIO_WHATSAPP_FROM = "whatsapp:+15551234567";
	process.env.TWILIO_AUTH_TOKEN = "token";
	vi.clearAllMocks();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("CLI commands", () => {
	it("send command routes to web provider", async () => {
		const sendWeb = vi.spyOn(provider, "sendMessageWeb").mockResolvedValue();
		await index.program.parseAsync(
			[
				"send",
				"--to",
				"+1555",
				"--message",
				"hi",
				"--provider",
				"web",
				"--wait",
				"0",
			],
			{ from: "user" },
		);
		expect(sendWeb).toHaveBeenCalled();
	});

	it("send command uses twilio path when provider=twilio", async () => {
		const twilio = (await import("twilio")).default;
		twilio._client.messages.create.mockResolvedValue({ sid: "SM1" });
		const wait = vi.spyOn(index, "waitForFinalStatus").mockResolvedValue();
		await index.program.parseAsync(
			["send", "--to", "+1555", "--message", "hi", "--wait", "0"],
			{ from: "user" },
		);
		expect(twilio._client.messages.create).toHaveBeenCalled();
		expect(wait).not.toHaveBeenCalled();
	});

	it("status command prints JSON", async () => {
		const twilio = (await import("twilio")).default;
		twilio._client.messages.list
			.mockResolvedValueOnce([
				{
					sid: "1",
					status: "delivered",
					direction: "inbound",
					dateCreated: new Date("2024-01-01T00:00:00Z"),
					from: "a",
					to: "b",
					body: "hi",
					errorCode: null,
					errorMessage: null,
				},
			])
			.mockResolvedValueOnce([
				{
					sid: "2",
					status: "sent",
					direction: "outbound-api",
					dateCreated: new Date("2024-01-02T00:00:00Z"),
					from: "b",
					to: "a",
					body: "yo",
					errorCode: null,
					errorMessage: null,
				},
			]);
		const runtime = {
			...defaultRuntime,
			log: vi.fn(),
			error: vi.fn(),
			exit: ((code: number) => {
				throw new Error(`exit ${code}`);
			}) as (code: number) => never,
		};
		await statusCommand(
			{ limit: "1", lookback: "10", json: true },
			createDefaultDeps(),
			runtime,
		);
		expect(runtime.log).toHaveBeenCalled();
	});
});
