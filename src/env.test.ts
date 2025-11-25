import { describe, expect, it, vi } from "vitest";

import { ensureTwilioEnv, readEnv } from "./env.js";
import type { RuntimeEnv } from "./runtime.js";

const baseEnv = {
	TWILIO_ACCOUNT_SID: "AC123",
	TWILIO_WHATSAPP_FROM: "whatsapp:+1555",
};

describe("env helpers", () => {
	const runtime: RuntimeEnv = {
		log: vi.fn(),
		error: vi.fn(),
		exit: vi.fn(() => {
			throw new Error("exit");
		}),
	};

	function setEnv(vars: Record<string, string | undefined>) {
		Object.assign(process.env, vars);
	}

	it("reads env with auth token", () => {
		setEnv({
			...baseEnv,
			TWILIO_AUTH_TOKEN: "token",
			TWILIO_API_KEY: undefined,
			TWILIO_API_SECRET: undefined,
		});
		const cfg = readEnv(runtime);
		expect(cfg.accountSid).toBe("AC123");
		expect(cfg.whatsappFrom).toBe("whatsapp:+1555");
		expect("authToken" in cfg.auth && cfg.auth.authToken).toBe("token");
	});

	it("reads env with API key/secret", () => {
		setEnv({
			...baseEnv,
			TWILIO_AUTH_TOKEN: undefined,
			TWILIO_API_KEY: "key",
			TWILIO_API_SECRET: "secret",
		});
		const cfg = readEnv(runtime);
		expect("apiKey" in cfg.auth && cfg.auth.apiKey).toBe("key");
		expect("apiSecret" in cfg.auth && cfg.auth.apiSecret).toBe("secret");
	});

	it("fails fast on invalid env", () => {
		setEnv({
			TWILIO_ACCOUNT_SID: "",
			TWILIO_WHATSAPP_FROM: "",
			TWILIO_AUTH_TOKEN: undefined,
			TWILIO_API_KEY: undefined,
			TWILIO_API_SECRET: undefined,
		});
		expect(() => readEnv(runtime)).toThrow("exit");
		expect(runtime.error).toHaveBeenCalled();
	});

	it("ensureTwilioEnv passes when token present", () => {
		setEnv({
			...baseEnv,
			TWILIO_AUTH_TOKEN: "token",
			TWILIO_API_KEY: undefined,
			TWILIO_API_SECRET: undefined,
		});
		expect(() => ensureTwilioEnv(runtime)).not.toThrow();
	});

	it("ensureTwilioEnv fails when missing auth", () => {
		setEnv({
			...baseEnv,
			TWILIO_AUTH_TOKEN: undefined,
			TWILIO_API_KEY: undefined,
			TWILIO_API_SECRET: undefined,
		});
		expect(() => ensureTwilioEnv(runtime)).toThrow("exit");
	});
});
