import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import JSON5 from "json5";
import { z } from "zod";

export type ReplyMode = "text" | "command";
export type ClaudeOutputFormat = "text" | "json" | "stream-json";
export type SessionScope = "per-sender" | "global";

export type SessionConfig = {
	scope?: SessionScope;
	resetTriggers?: string[];
	idleMinutes?: number;
	store?: string;
	sessionArgNew?: string[];
	sessionArgResume?: string[];
	sessionArgBeforeBody?: boolean;
};

export type LoggingConfig = {
	level?: "silent" | "fatal" | "error" | "warn" | "info" | "debug" | "trace";
	file?: string;
};

export type WarelayConfig = {
	logging?: LoggingConfig;
	inbound?: {
		allowFrom?: string[]; // E.164 numbers allowed to trigger auto-reply (without whatsapp:)
		reply?: {
			mode: ReplyMode;
			text?: string; // for mode=text, can contain {{Body}}
			command?: string[]; // for mode=command, argv with templates
			cwd?: string; // working directory for command execution
			template?: string; // prepend template string when building command/prompt
			timeoutSeconds?: number; // optional command timeout; defaults to 600s
			bodyPrefix?: string; // optional string prepended to Body before templating
			mediaUrl?: string; // optional media attachment (path or URL)
			session?: SessionConfig;
			claudeOutputFormat?: ClaudeOutputFormat; // when command starts with `claude`, force an output format
		};
	};
};

export const CONFIG_PATH = path.join(os.homedir(), ".warelay", "warelay.json");

const ReplySchema = z
	.object({
		mode: z.union([z.literal("text"), z.literal("command")]),
		text: z.string().optional(),
		command: z.array(z.string()).optional(),
		cwd: z.string().optional(),
		template: z.string().optional(),
		timeoutSeconds: z.number().int().positive().optional(),
		bodyPrefix: z.string().optional(),
		mediaUrl: z.string().optional(),
		session: z
			.object({
				scope: z
					.union([z.literal("per-sender"), z.literal("global")])
					.optional(),
				resetTriggers: z.array(z.string()).optional(),
				idleMinutes: z.number().int().positive().optional(),
				store: z.string().optional(),
				sessionArgNew: z.array(z.string()).optional(),
				sessionArgResume: z.array(z.string()).optional(),
				sessionArgBeforeBody: z.boolean().optional(),
			})
			.optional(),
		claudeOutputFormat: z
			.union([
				z.literal("text"),
				z.literal("json"),
				z.literal("stream-json"),
				z.undefined(),
			])
			.optional(),
	})
	.refine(
		(val) => (val.mode === "text" ? Boolean(val.text) : Boolean(val.command)),
		{
			message:
				"reply.text is required for mode=text; reply.command is required for mode=command",
		},
	);

const WarelaySchema = z.object({
	logging: z
		.object({
			level: z
				.union([
					z.literal("silent"),
					z.literal("fatal"),
					z.literal("error"),
					z.literal("warn"),
					z.literal("info"),
					z.literal("debug"),
					z.literal("trace"),
				])
				.optional(),
			file: z.string().optional(),
		})
		.optional(),
	inbound: z
		.object({
			allowFrom: z.array(z.string()).optional(),
			reply: ReplySchema.optional(),
		})
		.optional(),
});

export function loadConfig(): WarelayConfig {
	// Read ~/.warelay/warelay.json (JSON5) if present.
	try {
		if (!fs.existsSync(CONFIG_PATH)) return {};
		const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
		const parsed = JSON5.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return {};
		const validated = WarelaySchema.safeParse(parsed);
		if (!validated.success) {
			console.error("Invalid warelay config:");
			for (const iss of validated.error.issues) {
				console.error(`- ${iss.path.join(".")}: ${iss.message}`);
			}
			return {};
		}
		return validated.data as WarelayConfig;
	} catch (err) {
		console.error(`Failed to read config at ${CONFIG_PATH}`, err);
		return {};
	}
}
