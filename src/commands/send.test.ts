import { describe, expect, it, vi } from "vitest";

import type { CliDeps } from "../cli/deps.js";
import type { RuntimeEnv } from "../runtime.js";
import { sendCommand } from "./send.js";

const runtime: RuntimeEnv = {
	log: vi.fn(),
	error: vi.fn(),
	exit: vi.fn(() => {
		throw new Error("exit");
	}),
};

const baseDeps = {
	assertProvider: vi.fn(),
	sendMessageWeb: vi.fn(),
	resolveTwilioMediaUrl: vi.fn(),
	sendMessage: vi.fn(),
	waitForFinalStatus: vi.fn(),
} as unknown as CliDeps;

describe("sendCommand", () => {
	it("validates wait and poll", async () => {
		await expect(() =>
			sendCommand(
				{
					to: "+1",
					message: "hi",
					wait: "-1",
					poll: "2",
					provider: "twilio",
				},
				baseDeps,
				runtime,
			),
		).rejects.toThrow("Wait must be >= 0 seconds");

		await expect(() =>
			sendCommand(
				{
					to: "+1",
					message: "hi",
					wait: "0",
					poll: "0",
					provider: "twilio",
				},
				baseDeps,
				runtime,
			),
		).rejects.toThrow("Poll must be > 0 seconds");
	});

	it("handles web dry-run and warns on wait", async () => {
		const deps = {
			...baseDeps,
			sendMessageWeb: vi.fn(),
		} as CliDeps;
		await sendCommand(
			{
				to: "+1",
				message: "hi",
				wait: "5",
				poll: "2",
				provider: "web",
				dryRun: true,
				media: "pic.jpg",
			},
			deps,
			runtime,
		);
		expect(deps.sendMessageWeb).not.toHaveBeenCalled();
	});

	it("sends via web and outputs JSON", async () => {
		const deps = {
			...baseDeps,
			sendMessageWeb: vi.fn().mockResolvedValue({ messageId: "web1" }),
		} as CliDeps;
		await sendCommand(
			{
				to: "+1",
				message: "hi",
				wait: "1",
				poll: "2",
				provider: "web",
				json: true,
			},
			deps,
			runtime,
		);
		expect(deps.sendMessageWeb).toHaveBeenCalled();
		expect(runtime.log).toHaveBeenCalledWith(
			expect.stringContaining("\"provider\": \"web\""),
		);
	});

	it("supports twilio dry-run", async () => {
		const deps = { ...baseDeps } as CliDeps;
		await sendCommand(
			{
				to: "+1",
				message: "hi",
				wait: "0",
				poll: "2",
				provider: "twilio",
				dryRun: true,
			},
			deps,
			runtime,
		);
		expect(deps.sendMessage).not.toHaveBeenCalled();
	});

	it("sends via twilio with media and skips wait when zero", async () => {
		const deps = {
			...baseDeps,
			resolveTwilioMediaUrl: vi.fn().mockResolvedValue("https://media"),
			sendMessage: vi.fn().mockResolvedValue({ sid: "SM1", client: {} }),
			waitForFinalStatus: vi.fn(),
		} as CliDeps;
		await sendCommand(
			{
				to: "+1",
				message: "hi",
				wait: "0",
				poll: "2",
				provider: "twilio",
				media: "pic.jpg",
				serveMedia: true,
				json: true,
			},
			deps,
			runtime,
		);
		expect(deps.resolveTwilioMediaUrl).toHaveBeenCalledWith("pic.jpg", {
			serveMedia: true,
			runtime,
		});
		expect(deps.waitForFinalStatus).not.toHaveBeenCalled();
		expect(runtime.log).toHaveBeenCalledWith(
			expect.stringContaining("\"provider\": \"twilio\""),
		);
	});
});
