#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process, { stdin as input, stdout as output } from "node:process";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import bodyParser from "body-parser";
import chalk from "chalk";
import { Command } from "commander";
import dotenv from "dotenv";
import express, { type Request, type Response } from "express";
import JSON5 from "json5";
import Twilio from "twilio";
import type { MessageInstance } from "twilio/lib/rest/api/v2010/account/message.js";
import { z } from "zod";
import { sendCommand } from "./commands/send.js";
import { statusCommand } from "./commands/status.js";
import { upCommand } from "./commands/up.js";
import { webhookCommand } from "./commands/webhook.js";
import {
	danger,
	info,
	isVerbose,
	isYes,
	logVerbose,
	setVerbose,
	setYes,
	success,
	warn,
} from "./globals.js";
import {
	loginWeb,
	monitorWebInbox,
	sendMessageWeb,
	webAuthExists,
} from "./provider-web.js";
import type { Provider } from "./utils.js";
import {
	assertProvider,
	CONFIG_DIR,
	normalizeE164,
	normalizePath,
	sleep,
	withWhatsAppPrefix,
} from "./utils.js";

dotenv.config({ quiet: true });

const program = new Command();

type AuthMode =
	| { accountSid: string; authToken: string }
	| { accountSid: string; apiKey: string; apiSecret: string };

type CliDeps = {
	sendMessage: typeof sendMessage;
	sendMessageWeb: typeof sendMessageWeb;
	waitForFinalStatus: typeof waitForFinalStatus;
	assertProvider: typeof assertProvider;
	createClient?: typeof createClient;
	monitorTwilio: typeof monitorTwilio;
	listRecentMessages: typeof listRecentMessages;
	ensurePortAvailable: typeof ensurePortAvailable;
	startWebhook: typeof startWebhook;
	waitForever: typeof waitForever;
	ensureBinary: typeof ensureBinary;
	ensureFunnel: typeof ensureFunnel;
	getTailnetHostname: typeof getTailnetHostname;
	readEnv: typeof readEnv;
	findWhatsappSenderSid: typeof findWhatsappSenderSid;
	updateWebhook: typeof updateWebhook;
	handlePortError: typeof handlePortError;
	monitorWebProvider: typeof monitorWebProvider;
};

function createDefaultDeps(): CliDeps {
	return {
		sendMessage,
		sendMessageWeb,
		waitForFinalStatus,
		assertProvider,
		createClient,
		monitorTwilio,
		listRecentMessages,
		ensurePortAvailable,
		startWebhook,
		waitForever,
		ensureBinary,
		ensureFunnel,
		getTailnetHostname,
		readEnv,
		findWhatsappSenderSid,
		updateWebhook,
		handlePortError,
		monitorWebProvider,
	};
}

type TwilioRequestOptions = {
	method: "get" | "post";
	uri: string;
	params?: Record<string, string | number>;
	form?: Record<string, string>;
	body?: unknown;
	contentType?: string;
};

type TwilioSender = { sid: string; sender_id: string };

type TwilioRequestResponse = {
	data?: {
		senders?: TwilioSender[];
	};
};

type IncomingNumber = {
	sid: string;
	phoneNumber: string;
	smsUrl?: string;
};

type TwilioChannelsSender = {
	sid?: string;
	senderId?: string;
	sender_id?: string;
	webhook?: {
		callback_url?: string;
		callback_method?: string;
		fallback_url?: string;
		fallback_method?: string;
	};
};

type ChannelSenderUpdater = {
	update: (params: Record<string, string>) => Promise<unknown>;
};

type IncomingPhoneNumberUpdater = {
	update: (params: Record<string, string>) => Promise<unknown>;
};

type IncomingPhoneNumbersClient = {
	list: (params: {
		phoneNumber: string;
		limit?: number;
	}) => Promise<IncomingNumber[]>;
	get: (sid: string) => IncomingPhoneNumberUpdater;
} & ((sid: string) => IncomingPhoneNumberUpdater);

type TwilioSenderListClient = {
	messaging: {
		v2: {
			channelsSenders: {
				list: (params: {
					channel: string;
					pageSize: number;
				}) => Promise<TwilioChannelsSender[]>;
				(
					sid: string,
				): ChannelSenderUpdater & {
					fetch: () => Promise<TwilioChannelsSender>;
				};
			};
		};
		v1: {
			services: (sid: string) => {
				update: (params: Record<string, string>) => Promise<unknown>;
				fetch: () => Promise<{ inboundRequestUrl?: string }>;
			};
		};
	};
	incomingPhoneNumbers: IncomingPhoneNumbersClient;
};

type TwilioRequester = {
	request: (options: TwilioRequestOptions) => Promise<TwilioRequestResponse>;
};

type EnvConfig = {
	accountSid: string;
	whatsappFrom: string;
	whatsappSenderSid?: string;
	auth: AuthMode;
};

type RuntimeEnv = {
	log: typeof console.log;
	error: typeof console.error;
	exit: (code: number) => never;
};

const defaultRuntime: RuntimeEnv = {
	log: console.log,
	error: console.error,
	exit: (code) => {
		process.exit(code);
		throw new Error("unreachable"); // satisfies tests when mocked
	},
};

const EnvSchema = z
	.object({
		TWILIO_ACCOUNT_SID: z.string().min(1, "TWILIO_ACCOUNT_SID required"),
		TWILIO_WHATSAPP_FROM: z.string().min(1, "TWILIO_WHATSAPP_FROM required"),
		TWILIO_SENDER_SID: z.string().optional(),
		TWILIO_AUTH_TOKEN: z.string().optional(),
		TWILIO_API_KEY: z.string().optional(),
		TWILIO_API_SECRET: z.string().optional(),
	})
	.superRefine((val, ctx) => {
		if (val.TWILIO_API_KEY && !val.TWILIO_API_SECRET) {
			ctx.addIssue({
				code: "custom",
				message: "TWILIO_API_SECRET required when TWILIO_API_KEY is set",
			});
		}
		if (val.TWILIO_API_SECRET && !val.TWILIO_API_KEY) {
			ctx.addIssue({
				code: "custom",
				message: "TWILIO_API_KEY required when TWILIO_API_SECRET is set",
			});
		}
		if (
			!val.TWILIO_AUTH_TOKEN &&
			!(val.TWILIO_API_KEY && val.TWILIO_API_SECRET)
		) {
			ctx.addIssue({
				code: "custom",
				message:
					"Provide TWILIO_AUTH_TOKEN or both TWILIO_API_KEY and TWILIO_API_SECRET",
			});
		}
	});

function readEnv(runtime: RuntimeEnv = defaultRuntime): EnvConfig {
	// Load and validate Twilio auth + sender configuration from env.
	const parsed = EnvSchema.safeParse(process.env);
	if (!parsed.success) {
		runtime.error("Invalid environment configuration:");
		parsed.error.issues.forEach((iss) => {
			runtime.error(`- ${iss.message}`);
		});
		runtime.exit(1);
	}

	const {
		TWILIO_ACCOUNT_SID: accountSid,
		TWILIO_WHATSAPP_FROM: whatsappFrom,
		TWILIO_SENDER_SID: whatsappSenderSid,
		TWILIO_AUTH_TOKEN: authToken,
		TWILIO_API_KEY: apiKey,
		TWILIO_API_SECRET: apiSecret,
	} = parsed.data;

	let auth: AuthMode;
	if (apiKey && apiSecret) {
		auth = { accountSid, apiKey, apiSecret };
	} else if (authToken) {
		auth = { accountSid, authToken };
	} else {
		runtime.error("Missing Twilio auth configuration");
		runtime.exit(1);
		throw new Error("unreachable");
	}

	return {
		accountSid,
		whatsappFrom,
		whatsappSenderSid,
		auth,
	};
}

const execFileAsync = promisify(execFile);

type ExecResult = { stdout: string; stderr: string };

type ExecOptions = { maxBuffer?: number; timeoutMs?: number };

async function runExec(
	command: string,
	args: string[],
	{ maxBuffer = 2_000_000, timeoutMs }: ExecOptions = {},
): Promise<ExecResult> {
	// Thin wrapper around execFile with utf8 output.
	if (isVerbose()) {
		console.log(`$ ${command} ${args.join(" ")}`);
	}
	try {
		const { stdout, stderr } = await execFileAsync(command, args, {
			maxBuffer,
			encoding: "utf8",
			timeout: timeoutMs,
		});
		if (isVerbose()) {
			if (stdout.trim()) console.log(stdout.trim());
			if (stderr.trim()) console.error(stderr.trim());
		}
		return { stdout, stderr };
	} catch (err) {
		if (isVerbose()) {
			console.error(danger(`Command failed: ${command} ${args.join(" ")}`));
		}
		throw err;
	}
}

type SpawnResult = {
	stdout: string;
	stderr: string;
	code: number | null;
	signal: NodeJS.Signals | null;
	killed: boolean;
};

async function runCommandWithTimeout(
	argv: string[],
	timeoutMs: number,
): Promise<SpawnResult> {
	// Spawn with inherited stdin (TTY) so tools like `claude` don't hang.
	return await new Promise((resolve, reject) => {
		const child = spawn(argv[0], argv.slice(1), {
			stdio: ["inherit", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
		}, timeoutMs);

		child.stdout?.on("data", (d) => {
			stdout += d.toString();
		});
		child.stderr?.on("data", (d) => {
			stderr += d.toString();
		});
		child.on("error", (err) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(err);
		});
		child.on("close", (code, signal) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ stdout, stderr, code, signal, killed: child.killed });
		});
	});
}

class PortInUseError extends Error {
	port: number;

	details?: string;

	constructor(port: number, details?: string) {
		super(`Port ${port} is already in use.`);
		this.name = "PortInUseError";
		this.port = port;
		this.details = details;
	}
}

function isErrno(err: unknown): err is NodeJS.ErrnoException {
	return Boolean(err && typeof err === "object" && "code" in err);
}

async function describePortOwner(port: number): Promise<string | undefined> {
	// Best-effort process info for a listening port (macOS/Linux).
	try {
		const { stdout } = await runExec("lsof", [
			"-i",
			`tcp:${port}`,
			"-sTCP:LISTEN",
			"-nP",
		]);
		const trimmed = stdout.trim();
		if (trimmed) return trimmed;
	} catch (err) {
		logVerbose(`lsof unavailable: ${String(err)}`);
	}
	return undefined;
}

async function ensurePortAvailable(port: number): Promise<void> {
	// Detect EADDRINUSE early with a friendly message.
	try {
		await new Promise<void>((resolve, reject) => {
			const tester = net
				.createServer()
				.once("error", (err) => reject(err))
				.once("listening", () => {
					tester.close(() => resolve());
				})
				.listen(port);
		});
	} catch (err) {
		if (isErrno(err) && err.code === "EADDRINUSE") {
			const details = await describePortOwner(port);
			throw new PortInUseError(port, details);
		}
		throw err;
	}
}

async function handlePortError(
	err: unknown,
	port: number,
	context: string,
	runtime: RuntimeEnv = defaultRuntime,
): Promise<never> {
	if (
		err instanceof PortInUseError ||
		(isErrno(err) && err.code === "EADDRINUSE")
	) {
		const details =
			err instanceof PortInUseError
				? err.details
				: await describePortOwner(port);
		runtime.error(danger(`${context} failed: port ${port} is already in use.`));
		if (details) {
			runtime.error(info("Port listener details:"));
			runtime.error(details);
			if (/warelay|src\/index\.ts|dist\/index\.js/.test(details)) {
				runtime.error(
					warn(
						"It looks like another warelay instance is already running. Stop it or pick a different port.",
					),
				);
			}
		}
		runtime.error(
			info(
				"Resolve by stopping the process using the port or passing --port <free-port>.",
			),
		);
		runtime.exit(1);
	}
	runtime.error(danger(`${context} failed: ${String(err)}`));
	return runtime.exit(1);
}

async function ensureBinary(
	name: string,
	exec: typeof runExec = runExec,
	runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
	// Abort early if a required CLI tool is missing.
	await exec("which", [name]).catch(() => {
		runtime.error(`Missing required binary: ${name}. Please install it.`);
		runtime.exit(1);
	});
}

async function promptYesNo(
	question: string,
	defaultYes = false,
): Promise<boolean> {
	if (isVerbose() && isYes()) return true; // redundant guard when both flags set
	if (isYes()) return true;
	const rl = readline.createInterface({ input, output });
	const suffix = defaultYes ? " [Y/n] " : " [y/N] ";
	const answer = (await rl.question(`${question}${suffix}`))
		.trim()
		.toLowerCase();
	rl.close();
	if (!answer) return defaultYes;
	return answer.startsWith("y");
}

const CONFIG_PATH = path.join(os.homedir(), ".warelay", "warelay.json");

type ReplyMode = "text" | "command";

type WarelayConfig = {
	inbound?: {
		allowFrom?: string[]; // E.164 numbers allowed to trigger auto-reply (without whatsapp:)
		reply?: {
			mode: ReplyMode;
			text?: string; // for mode=text, can contain {{Body}}
			command?: string[]; // for mode=command, argv with templates
			template?: string; // prepend template string when building command/prompt
			timeoutSeconds?: number; // optional command timeout; defaults to 600s
			bodyPrefix?: string; // optional string prepended to Body before templating
			session?: SessionConfig;
		};
	};
};

type SessionScope = "per-sender" | "global";

type SessionConfig = {
	scope?: SessionScope;
	resetTriggers?: string[];
	idleMinutes?: number;
	store?: string;
	sessionArgNew?: string[];
	sessionArgResume?: string[];
	sessionArgBeforeBody?: boolean;
};

function loadConfig(): WarelayConfig {
	// Read ~/.warelay/warelay.json (JSON5) if present.
	try {
		if (!fs.existsSync(CONFIG_PATH)) return {};
		const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
		const parsed = JSON5.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return {};
		return parsed as WarelayConfig;
	} catch (err) {
		console.error(`Failed to read config at ${CONFIG_PATH}`, err);
		return {};
	}
}

type MsgContext = {
	Body?: string;
	From?: string;
	To?: string;
	MessageSid?: string;
};

type GetReplyOptions = {
	onReplyStart?: () => Promise<void> | void;
};

function applyTemplate(str: string, ctx: TemplateContext) {
	// Simple {{Placeholder}} interpolation using inbound message context.
	return str.replace(/{{\s*(\w+)\s*}}/g, (_, key) => {
		const value = (ctx as Record<string, unknown>)[key];
		return value == null ? "" : String(value);
	});
}

type TemplateContext = MsgContext & {
	BodyStripped?: string;
	SessionId?: string;
	IsNewSession?: string;
};

type SessionEntry = { sessionId: string; updatedAt: number };

const SESSION_STORE_DEFAULT = path.join(CONFIG_DIR, "sessions.json");
const DEFAULT_RESET_TRIGGER = "/new";
const DEFAULT_IDLE_MINUTES = 60;

function resolveStorePath(store?: string) {
	if (!store) return SESSION_STORE_DEFAULT;
	if (store.startsWith("~"))
		return path.resolve(store.replace("~", os.homedir()));
	return path.resolve(store);
}

function loadSessionStore(storePath: string): Record<string, SessionEntry> {
	try {
		const raw = fs.readFileSync(storePath, "utf-8");
		const parsed = JSON5.parse(raw);
		if (parsed && typeof parsed === "object") {
			return parsed as Record<string, SessionEntry>;
		}
	} catch {
		// ignore missing/invalid store; we'll recreate it
	}
	return {};
}

async function saveSessionStore(
	storePath: string,
	store: Record<string, SessionEntry>,
) {
	await fs.promises.mkdir(path.dirname(storePath), { recursive: true });
	await fs.promises.writeFile(
		storePath,
		JSON.stringify(store, null, 2),
		"utf-8",
	);
}

function deriveSessionKey(scope: SessionScope, ctx: MsgContext) {
	if (scope === "global") return "global";
	const from = ctx.From ? normalizeE164(ctx.From) : "";
	return from || "unknown";
}

async function getReplyFromConfig(
	ctx: MsgContext,
	opts?: GetReplyOptions,
	configOverride?: WarelayConfig,
	commandRunner: typeof runCommandWithTimeout = runCommandWithTimeout,
): Promise<string | undefined> {
	// Choose reply from config: static text or external command stdout.
	const cfg = configOverride ?? loadConfig();
	const reply = cfg.inbound?.reply;
	const timeoutSeconds = Math.max(reply?.timeoutSeconds ?? 600, 1);
	const timeoutMs = timeoutSeconds * 1000;
	let started = false;
	const onReplyStart = async () => {
		if (started) return;
		started = true;
		await opts?.onReplyStart?.();
	};

	// Optional session handling (conversation reuse + /new resets)
	const sessionCfg = reply?.session;
	const resetTriggers = sessionCfg?.resetTriggers?.length
		? sessionCfg.resetTriggers
		: [DEFAULT_RESET_TRIGGER];
	const idleMinutes = Math.max(
		sessionCfg?.idleMinutes ?? DEFAULT_IDLE_MINUTES,
		1,
	);
	const sessionScope = sessionCfg?.scope ?? "per-sender";
	const storePath = resolveStorePath(sessionCfg?.store);

	let sessionId: string | undefined;
	let isNewSession = false;
	let bodyStripped: string | undefined;

	if (sessionCfg) {
		const trimmedBody = (ctx.Body ?? "").trim();
		for (const trigger of resetTriggers) {
			if (!trigger) continue;
			if (trimmedBody === trigger) {
				isNewSession = true;
				bodyStripped = "";
				break;
			}
			const triggerPrefix = `${trigger} `;
			if (trimmedBody.startsWith(triggerPrefix)) {
				isNewSession = true;
				bodyStripped = trimmedBody.slice(trigger.length).trimStart();
				break;
			}
		}

		const sessionKey = deriveSessionKey(sessionScope, ctx);
		const store = loadSessionStore(storePath);
		const entry = store[sessionKey];
		const idleMs = idleMinutes * 60_000;
		const freshEntry = entry && Date.now() - entry.updatedAt <= idleMs;

		if (!isNewSession && freshEntry) {
			sessionId = entry.sessionId;
		} else {
			sessionId = crypto.randomUUID();
			isNewSession = true;
		}

		store[sessionKey] = { sessionId, updatedAt: Date.now() };
		await saveSessionStore(storePath, store);
	}

	const sessionCtx: TemplateContext = {
		...ctx,
		BodyStripped: bodyStripped ?? ctx.Body,
		SessionId: sessionId,
		IsNewSession: isNewSession ? "true" : "false",
	};

	// Optional prefix injected before Body for templating/command prompts.
	const bodyPrefix = reply?.bodyPrefix
		? applyTemplate(reply.bodyPrefix, sessionCtx)
		: "";
	const prefixedBody = bodyPrefix
		? `${bodyPrefix}${sessionCtx.BodyStripped ?? sessionCtx.Body ?? ""}`
		: (sessionCtx.BodyStripped ?? sessionCtx.Body);
	const templatingCtx: TemplateContext = {
		...sessionCtx,
		Body: prefixedBody,
		BodyStripped: prefixedBody,
	};

	// Optional allowlist by origin number (E.164 without whatsapp: prefix)
	const allowFrom = cfg.inbound?.allowFrom;
	if (Array.isArray(allowFrom) && allowFrom.length > 0) {
		const from = (ctx.From ?? "").replace(/^whatsapp:/, "");
		if (!allowFrom.includes(from)) {
			logVerbose(
				`Skipping auto-reply: sender ${from || "<unknown>"} not in allowFrom list`,
			);
			return undefined;
		}
	}
	if (!reply) {
		logVerbose("No inbound.reply configured; skipping auto-reply");
		return undefined;
	}

	if (reply.mode === "text" && reply.text) {
		await onReplyStart();
		logVerbose("Using text auto-reply from config");
		return applyTemplate(reply.text, templatingCtx);
	}

	if (reply.mode === "command" && reply.command?.length) {
		await onReplyStart();
		let argv = reply.command.map((part) => applyTemplate(part, templatingCtx));
		const templatePrefix = reply.template
			? applyTemplate(reply.template, templatingCtx)
			: "";
		if (templatePrefix && argv.length > 0) {
			argv = [argv[0], templatePrefix, ...argv.slice(1)];
		}

		// Inject session args if configured (use resume for existing, session-id for new)
		if (reply.session) {
			const sessionArgList = (
				isNewSession
					? (reply.session.sessionArgNew ?? ["--session-id", "{{SessionId}}"])
					: (reply.session.sessionArgResume ?? ["--resume", "{{SessionId}}"])
			).map((part) => applyTemplate(part, templatingCtx));
			if (sessionArgList.length) {
				const insertBeforeBody = reply.session.sessionArgBeforeBody ?? true;
				const insertAt =
					insertBeforeBody && argv.length > 1 ? argv.length - 1 : argv.length;
				argv = [
					...argv.slice(0, insertAt),
					...sessionArgList,
					...argv.slice(insertAt),
				];
			}
		}
		const finalArgv = argv;
		logVerbose(`Running command auto-reply: ${finalArgv.join(" ")}`);
		const started = Date.now();
		try {
			const { stdout, stderr, code, signal, killed } = await commandRunner(
				finalArgv,
				timeoutMs,
			);
			const trimmed = stdout.trim();
			if (stderr?.trim()) {
				logVerbose(`Command auto-reply stderr: ${stderr.trim()}`);
			}
			logVerbose(
				`Command auto-reply stdout (trimmed): ${trimmed || "<empty>"}`,
			);
			logVerbose(`Command auto-reply finished in ${Date.now() - started}ms`);
			if ((code ?? 0) !== 0) {
				console.error(
					`Command auto-reply exited with code ${code ?? "unknown"} (signal: ${signal ?? "none"})`,
				);
				return undefined;
			}
			if (killed && !signal) {
				console.error(
					`Command auto-reply process killed before completion (exit code ${code ?? "unknown"})`,
				);
				return undefined;
			}
			return trimmed || undefined;
		} catch (err) {
			const elapsed = Date.now() - started;
			const anyErr = err as { killed?: boolean; signal?: string };
			const timeoutHit = anyErr.killed === true || anyErr.signal === "SIGKILL";
			const errorObj = err as {
				stdout?: string;
				stderr?: string;
			};
			if (errorObj.stderr?.trim()) {
				logVerbose(`Command auto-reply stderr: ${errorObj.stderr.trim()}`);
			}
			if (timeoutHit) {
				console.error(
					`Command auto-reply timed out after ${elapsed}ms (limit ${timeoutMs}ms)`,
				);
			} else {
				console.error(`Command auto-reply failed after ${elapsed}ms`, err);
			}
			return undefined;
		}
	}

	return undefined;
}

async function autoReplyIfConfigured(
	client: ReturnType<typeof createClient>,
	message: MessageInstance,
	configOverride?: WarelayConfig,
	runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
	// Fire a config-driven reply (text or command) for the inbound message, if configured.
	const ctx: MsgContext = {
		Body: message.body ?? undefined,
		From: message.from ?? undefined,
		To: message.to ?? undefined,
		MessageSid: message.sid,
	};

	const replyText = await getReplyFromConfig(
		ctx,
		{
			onReplyStart: () => sendTypingIndicator(client, message.sid, runtime),
		},
		configOverride,
	);
	if (!replyText) return;

	const replyFrom = message.to;
	const replyTo = message.from;
	if (!replyFrom || !replyTo) {
		if (isVerbose())
			console.error(
				"Skipping auto-reply: missing to/from on inbound message",
				ctx,
			);
		return;
	}

	logVerbose(
		`Auto-replying via Twilio: from ${replyFrom} to ${replyTo}, body length ${replyText.length}`,
	);

	try {
		await client.messages.create({
			from: replyFrom,
			to: replyTo,
			body: replyText,
		});
		if (isVerbose()) {
			console.log(
				success(
					`↩️  Auto-replied to ${replyTo} (sid ${message.sid ?? "no-sid"})`,
				),
			);
		}
	} catch (err) {
		logTwilioSendError(err, replyTo ?? undefined, runtime);
	}
}

function createClient(env: EnvConfig) {
	// Twilio client using either auth token or API key/secret.
	if ("authToken" in env.auth) {
		return Twilio(env.accountSid, env.auth.authToken, {
			accountSid: env.accountSid,
		});
	}
	return Twilio(env.auth.apiKey, env.auth.apiSecret, {
		accountSid: env.accountSid,
	});
}

async function sendTypingIndicator(
	client: ReturnType<typeof createClient>,
	messageSid?: string,
	runtime: RuntimeEnv = defaultRuntime,
) {
	// Best-effort WhatsApp typing indicator (public beta as of Nov 2025).
	if (!messageSid) {
		logVerbose("Skipping typing indicator: missing MessageSid");
		return;
	}
	try {
		const requester = client as unknown as TwilioRequester;
		await requester.request({
			method: "post",
			uri: "https://messaging.twilio.com/v2/Indicators/Typing.json",
			form: {
				messageId: messageSid,
				channel: "whatsapp",
			},
		});
		logVerbose(`Sent typing indicator for inbound ${messageSid}`);
	} catch (err) {
		if (isVerbose()) {
			runtime.error(warn("Typing indicator failed (continuing without it)"));
			runtime.error(err as Error);
		}
	}
}

async function sendMessage(
	to: string,
	body: string,
	runtime: RuntimeEnv = defaultRuntime,
) {
	// Send outbound WhatsApp message; exit non-zero on API failure.
	const env = readEnv(runtime);
	const client = createClient(env);
	const from = withWhatsAppPrefix(env.whatsappFrom);
	const toNumber = withWhatsAppPrefix(to);

	try {
		const message = await client.messages.create({
			from,
			to: toNumber,
			body,
		});

		console.log(
			success(
				`✅ Request accepted. Message SID: ${message.sid} -> ${toNumber}`,
			),
		);
		return { client, sid: message.sid };
	} catch (err) {
		const anyErr = err as {
			code?: string | number;
			message?: unknown;
			moreInfo?: unknown;
			status?: string | number;
			response?: { body?: unknown };
		};
		const { code, status } = anyErr;
		const msg =
			typeof anyErr?.message === "string"
				? anyErr.message
				: (anyErr?.message ?? err);
		const more = anyErr?.moreInfo;
		runtime.error(
			`❌ Twilio send failed${code ? ` (code ${code})` : ""}${status ? ` status ${status}` : ""}: ${msg}`,
		);
		if (more) console.error(`More info: ${more}`);
		// Some Twilio errors include response.body with more context.
		const responseBody = anyErr?.response?.body;
		if (responseBody) {
			console.error("Response body:", JSON.stringify(responseBody, null, 2));
		}
		runtime.exit(1);
	}
}

const successTerminalStatuses = new Set(["delivered", "read"]);
const failureTerminalStatuses = new Set(["failed", "undelivered", "canceled"]);

async function waitForFinalStatus(
	client: ReturnType<typeof createClient>,
	sid: string,
	timeoutSeconds: number,
	pollSeconds: number,
	runtime: RuntimeEnv = defaultRuntime,
) {
	// Poll message status until delivered/failed or timeout.
	const deadline = Date.now() + timeoutSeconds * 1000;
	while (Date.now() < deadline) {
		const m = await client.messages(sid).fetch();
		const status = m.status ?? "unknown";
		if (successTerminalStatuses.has(status)) {
			console.log(success(`✅ Delivered (status: ${status})`));
			return;
		}
		if (failureTerminalStatuses.has(status)) {
			runtime.error(
				`❌ Delivery failed (status: ${status}${
					m.errorCode ? `, code ${m.errorCode}` : ""
				})${m.errorMessage ? `: ${m.errorMessage}` : ""}`,
			);
			runtime.exit(1);
		}
		await sleep(pollSeconds * 1000);
	}
	console.log(
		"ℹ️  Timed out waiting for final status; message may still be in flight.",
	);
}

async function startWebhook(
	port: number,
	path = "/webhook/whatsapp",
	autoReply: string | undefined,
	verbose: boolean,
	runtime: RuntimeEnv = defaultRuntime,
): Promise<import("http").Server> {
	const normalizedPath = normalizePath(path);
	// Start Express webhook; generate replies via config or CLI flag.
	const env = readEnv(runtime);
	const app = express();

	// Twilio sends application/x-www-form-urlencoded
	app.use(bodyParser.urlencoded({ extended: false }));
	app.use((req, _res, next) => {
		runtime.log(chalk.gray(`REQ ${req.method} ${req.url}`));
		next();
	});

	app.post(normalizedPath, async (req: Request, res: Response) => {
		const { From, To, Body, MessageSid } = req.body ?? {};
		console.log(
			`[INBOUND] ${From ?? "unknown"} -> ${To ?? "unknown"} (${
				MessageSid ?? "no-sid"
			})`,
		);
		if (verbose) runtime.log(chalk.gray(`Body: ${Body ?? ""}`));

		const client = createClient(env);
		let replyText = autoReply;
		if (!replyText) {
			replyText = await getReplyFromConfig(
				{
					Body,
					From,
					To,
					MessageSid,
				},
				{
					onReplyStart: () => sendTypingIndicator(client, MessageSid, runtime),
				},
			);
		}

		if (replyText) {
			try {
				await client.messages.create({
					from: To,
					to: From,
					body: replyText,
				});
				if (verbose) {
					runtime.log(success(`↩️  Auto-replied to ${From}`));
				}
			} catch (err) {
				logTwilioSendError(err, From ?? undefined, runtime);
			}
		}

		// Respond 200 OK to Twilio
		res.type("text/xml").send("<Response></Response>");
	});

	app.use((_req, res) => {
		if (verbose) runtime.log(chalk.yellow(`404 ${_req.method} ${_req.url}`));
		res.status(404).send("warelay webhook: not found");
	});

	return await new Promise((resolve, reject) => {
		const server = app.listen(port);

		const onListening = () => {
			cleanup();
			runtime.log(
				`📥 Webhook listening on http://localhost:${port}${normalizedPath}`,
			);
			resolve(server);
		};

		const onError = (err: NodeJS.ErrnoException) => {
			cleanup();
			reject(err);
		};

		const cleanup = () => {
			server.off("listening", onListening);
			server.off("error", onError);
		};

		server.once("listening", onListening);
		server.once("error", onError);
	});
}

function waitForever() {
	// Keep event loop alive via an unref'ed interval plus a pending promise.
	const interval = setInterval(() => {}, 1_000_000);
	interval.unref();
	return new Promise<void>(() => {
		/* never resolve */
	});
}

async function getTailnetHostname(exec: typeof runExec = runExec) {
	// Derive tailnet hostname (or IP fallback) from tailscale status JSON.
	const { stdout } = await exec("tailscale", ["status", "--json"]);
	const parsed = stdout ? (JSON.parse(stdout) as Record<string, unknown>) : {};
	const self =
		typeof parsed.Self === "object" && parsed.Self !== null
			? (parsed.Self as Record<string, unknown>)
			: undefined;
	const dns =
		typeof self?.DNSName === "string" ? (self.DNSName as string) : undefined;
	const ips = Array.isArray(self?.TailscaleIPs)
		? (self.TailscaleIPs as string[])
		: [];
	if (dns && dns.length > 0) return dns.replace(/\.$/, "");
	if (ips.length > 0) return ips[0];
	throw new Error("Could not determine Tailscale DNS or IP");
}

async function ensureGoInstalled(
	exec: typeof runExec = runExec,
	prompt: typeof promptYesNo = promptYesNo,
	runtime: RuntimeEnv = defaultRuntime,
) {
	// Ensure Go toolchain is present; offer Homebrew install if missing.
	const hasGo = await exec("go", ["version"]).then(
		() => true,
		() => false,
	);
	if (hasGo) return;
	const install = await prompt(
		"Go is not installed. Install via Homebrew (brew install go)?",
		true,
	);
	if (!install) {
		runtime.error("Go is required to build tailscaled from source. Aborting.");
		runtime.exit(1);
	}
	logVerbose("Installing Go via Homebrew…");
	await exec("brew", ["install", "go"]);
}

async function ensureTailscaledInstalled(
	exec: typeof runExec = runExec,
	prompt: typeof promptYesNo = promptYesNo,
	runtime: RuntimeEnv = defaultRuntime,
) {
	// Ensure tailscaled binary exists; install via Homebrew tailscale if missing.
	const hasTailscaled = await exec("tailscaled", ["--version"]).then(
		() => true,
		() => false,
	);
	if (hasTailscaled) return;

	const install = await prompt(
		"tailscaled not found. Install via Homebrew (tailscale package)?",
		true,
	);
	if (!install) {
		runtime.error("tailscaled is required for user-space funnel. Aborting.");
		runtime.exit(1);
	}
	logVerbose("Installing tailscaled via Homebrew…");
	await exec("brew", ["install", "tailscale"]);
}

async function ensureFunnel(
	port: number,
	exec: typeof runExec = runExec,
	runtime: RuntimeEnv = defaultRuntime,
	prompt: typeof promptYesNo = promptYesNo,
) {
	// Ensure Funnel is enabled and publish the webhook port.
	try {
		const statusOut = (
			await exec("tailscale", ["funnel", "status", "--json"])
		).stdout.trim();
		const parsed = statusOut
			? (JSON.parse(statusOut) as Record<string, unknown>)
			: {};
		if (!parsed || Object.keys(parsed).length === 0) {
			runtime.error(
				danger("Tailscale Funnel is not enabled on this tailnet/device."),
			);
			runtime.error(
				info(
					"Enable in admin console: https://login.tailscale.com/admin (see https://tailscale.com/kb/1223/funnel)",
				),
			);
			runtime.error(
				info(
					"macOS user-space tailscaled docs: https://github.com/tailscale/tailscale/wiki/Tailscaled-on-macOS",
				),
			);
			const proceed = await prompt(
				"Attempt local setup with user-space tailscaled?",
				true,
			);
			if (!proceed) runtime.exit(1);
			await ensureGoInstalled(exec, prompt, runtime);
			await ensureTailscaledInstalled(exec, prompt, runtime);
		}

		logVerbose(`Enabling funnel on port ${port}…`);
		const { stdout } = await exec(
			"tailscale",
			["funnel", "--yes", "--bg", `${port}`],
			{
				maxBuffer: 200_000,
				timeoutMs: 15_000,
			},
		);
		if (stdout.trim()) console.log(stdout.trim());
	} catch (err) {
		const errOutput = err as { stdout?: unknown; stderr?: unknown };
		const stdout = typeof errOutput.stdout === "string" ? errOutput.stdout : "";
		const stderr = typeof errOutput.stderr === "string" ? errOutput.stderr : "";
		if (stdout.includes("Funnel is not enabled")) {
			console.error(danger("Funnel is not enabled on this tailnet/device."));
			const linkMatch = stdout.match(/https?:\/\/\S+/);
			if (linkMatch) {
				console.error(info(`Enable it here: ${linkMatch[0]}`));
			} else {
				console.error(
					info(
						"Enable in admin console: https://login.tailscale.com/admin (see https://tailscale.com/kb/1223/funnel)",
					),
				);
			}
		}
		if (
			stderr.includes("client version") ||
			stdout.includes("client version")
		) {
			console.error(
				warn(
					"Tailscale client/server version mismatch detected; try updating tailscale/tailscaled.",
				),
			);
		}
		runtime.error(
			"Failed to enable Tailscale Funnel. Is it allowed on your tailnet?",
		);
		runtime.error(
			info(
				"Tip: you can fall back to polling (no webhooks needed): `pnpm warelay relay --provider twilio --interval 5 --lookback 10`",
			),
		);
		if (isVerbose()) {
			if (stdout.trim()) runtime.error(chalk.gray(`stdout: ${stdout.trim()}`));
			if (stderr.trim()) runtime.error(chalk.gray(`stderr: ${stderr.trim()}`));
			runtime.error(err as Error);
		}
		runtime.exit(1);
	}
}

async function findWhatsappSenderSid(
	client: ReturnType<typeof createClient>,
	from: string,
	explicitSenderSid?: string,
	runtime: RuntimeEnv = defaultRuntime,
) {
	// Use explicit sender SID if provided, otherwise list and match by sender_id.
	if (explicitSenderSid) {
		logVerbose(`Using TWILIO_SENDER_SID from env: ${explicitSenderSid}`);
		return explicitSenderSid;
	}
	try {
		// Prefer official SDK list helper to avoid request-shape mismatches.
		// Twilio helper types are broad; we narrow to expected shape.
		const senderClient = client as unknown as TwilioSenderListClient;
		const senders = await senderClient.messaging.v2.channelsSenders.list({
			channel: "whatsapp",
			pageSize: 50,
		});
		if (!senders) {
			throw new Error('List senders response missing "senders" array');
		}
		const match = senders.find(
			(s) =>
				(typeof s.senderId === "string" &&
					s.senderId === withWhatsAppPrefix(from)) ||
				(typeof s.sender_id === "string" &&
					s.sender_id === withWhatsAppPrefix(from)),
		);
		if (!match || typeof match.sid !== "string") {
			throw new Error(
				`Could not find sender ${withWhatsAppPrefix(from)} in Twilio account`,
			);
		}
		return match.sid;
	} catch (err) {
		runtime.error(danger("Unable to list WhatsApp senders via Twilio API."));
		if (isVerbose()) {
			runtime.error(err as Error);
		}
		runtime.error(
			info(
				"Set TWILIO_SENDER_SID in .env to skip discovery (Twilio Console → Messaging → Senders → WhatsApp).",
			),
		);
		runtime.exit(1);
	}
}

async function findIncomingNumberSid(
	client: TwilioSenderListClient,
): Promise<string | null> {
	// Try to locate the underlying phone number and return its SID for webhook fallback.
	const env = readEnv();
	const phone = env.whatsappFrom.replace("whatsapp:", "");
	try {
		const list = await client.incomingPhoneNumbers.list({
			phoneNumber: phone,
			limit: 2,
		});
		if (!list || list.length === 0) return null;
		if (list.length > 1 && isVerbose()) {
			console.error(
				warn("Multiple incoming numbers matched; using the first."),
			);
		}
		return list[0]?.sid ?? null;
	} catch (err) {
		if (isVerbose()) console.error("incomingPhoneNumbers.list failed", err);
		return null;
	}
}

async function findMessagingServiceSid(
	client: TwilioSenderListClient,
): Promise<string | null> {
	// Attempt to locate a messaging service tied to the WA phone number (webhook fallback).
	type IncomingNumberWithService = { messagingServiceSid?: string };
	try {
		const env = readEnv();
		const phone = env.whatsappFrom.replace("whatsapp:", "");
		const list = await client.incomingPhoneNumbers.list({
			phoneNumber: phone,
			limit: 1,
		});
		const msid =
			(list?.[0] as IncomingNumberWithService | undefined)
				?.messagingServiceSid ?? null;
		return msid;
	} catch (err) {
		if (isVerbose()) console.error("findMessagingServiceSid failed", err);
		return null;
	}
}

async function setMessagingServiceWebhook(
	client: TwilioSenderListClient,
	url: string,
	method: "POST" | "GET",
): Promise<boolean> {
	const msid = await findMessagingServiceSid(client);
	if (!msid) return false;
	try {
		await client.messaging.v1.services(msid).update({
			InboundRequestUrl: url,
			InboundRequestMethod: method,
		});
		const fetched = await client.messaging.v1.services(msid).fetch();
		const stored = fetched?.inboundRequestUrl;
		console.log(
			success(
				`✅ Messaging Service webhook set to ${stored ?? url} (service ${msid})`,
			),
		);
		return true;
	} catch (err) {
		if (isVerbose()) console.error("Messaging Service update failed", err);
		return false;
	}
}

async function updateWebhook(
	client: ReturnType<typeof createClient>,
	senderSid: string,
	url: string,
	method: "POST" | "GET" = "POST",
	runtime: RuntimeEnv = defaultRuntime,
) {
	// Point Twilio sender webhook at the provided URL.
	const requester = client as unknown as TwilioRequester;
	const clientTyped = client as unknown as TwilioSenderListClient;

	// 1) Raw request (Channels/Senders) with JSON webhook payload — most reliable for WA
	try {
		await requester.request({
			method: "post",
			uri: `https://messaging.twilio.com/v2/Channels/Senders/${senderSid}`,
			body: {
				webhook: {
					callback_url: url,
					callback_method: method,
				},
			},
			contentType: "application/json",
		});
		// Fetch to verify what Twilio stored
		const fetched = await clientTyped.messaging.v2
			.channelsSenders(senderSid)
			.fetch();
		const storedUrl =
			fetched?.webhook?.callback_url || fetched?.webhook?.fallback_url;
		if (storedUrl) {
			console.log(success(`✅ Twilio sender webhook set to ${storedUrl}`));
			return;
		}
		if (isVerbose())
			console.error(
				"Sender updated but webhook callback_url missing; will try fallbacks",
			);
	} catch (err) {
		if (isVerbose())
			console.error(
				"channelsSenders request update failed, will try client helpers",
				err,
			);
	}

	// 1b) Form-encoded fallback for older Twilio stacks
	try {
		await requester.request({
			method: "post",
			uri: `https://messaging.twilio.com/v2/Channels/Senders/${senderSid}`,
			form: {
				"Webhook.CallbackUrl": url,
				"Webhook.CallbackMethod": method,
			},
		});
		const fetched = await clientTyped.messaging.v2
			.channelsSenders(senderSid)
			.fetch();
		const storedUrl =
			fetched?.webhook?.callback_url || fetched?.webhook?.fallback_url;
		if (storedUrl) {
			console.log(success(`✅ Twilio sender webhook set to ${storedUrl}`));
			return;
		}
		if (isVerbose())
			console.error(
				"Form update succeeded but callback_url missing; will try helper fallback",
			);
	} catch (err) {
		if (isVerbose())
			console.error(
				"Form channelsSenders update failed, will try helper fallback",
				err,
			);
	}

	// 2) SDK helper fallback (if supported by this client)
	try {
		if (clientTyped.messaging?.v2?.channelsSenders) {
			await clientTyped.messaging.v2.channelsSenders(senderSid).update({
				callbackUrl: url,
				callbackMethod: method,
			});
			const fetched = await clientTyped.messaging.v2
				.channelsSenders(senderSid)
				.fetch();
			const storedUrl =
				fetched?.webhook?.callback_url || fetched?.webhook?.fallback_url;
			console.log(
				success(
					`✅ Twilio sender webhook set to ${storedUrl ?? url} (helper API)`,
				),
			);
			return;
		}
	} catch (err) {
		if (isVerbose())
			console.error(
				"channelsSenders helper update failed, will try phone number fallback",
				err,
			);
	}

	// 3) Incoming phone number fallback (works for many WA senders)
	try {
		const phoneSid = await findIncomingNumberSid(clientTyped);
		if (phoneSid) {
			const phoneNumberUpdater = clientTyped.incomingPhoneNumbers(phoneSid);
			await phoneNumberUpdater.update({
				smsUrl: url,
				smsMethod: method,
			});
			console.log(success(`✅ Twilio phone webhook set to ${url}`));
			return;
		}
	} catch (err) {
		if (isVerbose()) console.error("Incoming number update failed", err);
	}

	// 4) Messaging Service fallback (some WA senders are tied to a service)
	const messagingServiceUpdated = await setMessagingServiceWebhook(
		clientTyped,
		url,
		method,
	);
	if (messagingServiceUpdated) return;

	runtime.error(danger("Failed to set Twilio webhook."));
	runtime.error(
		info(
			"Double-check your sender SID and credentials; you can set TWILIO_SENDER_SID to force a specific sender.",
		),
	);
	runtime.error(
		info(
			"Tip: if webhooks are blocked, use polling instead: `pnpm warelay relay --provider twilio --interval 5 --lookback 10`",
		),
	);
	runtime.exit(1);
}

type TwilioApiError = {
	code?: number | string;
	status?: number | string;
	message?: string;
	moreInfo?: string;
	response?: { body?: unknown };
};

function formatTwilioError(err: unknown): string {
	const e = err as TwilioApiError;
	const pieces = [];
	if (e.code != null) pieces.push(`code ${e.code}`);
	if (e.status != null) pieces.push(`status ${e.status}`);
	if (e.message) pieces.push(e.message);
	if (e.moreInfo) pieces.push(`more: ${e.moreInfo}`);
	return pieces.length ? pieces.join(" | ") : String(err);
}

function logTwilioSendError(
	err: unknown,
	destination?: string,
	runtime: RuntimeEnv = defaultRuntime,
) {
	const prefix = destination ? `to ${destination}: ` : "";
	runtime.error(
		danger(`❌ Twilio send failed ${prefix}${formatTwilioError(err)}`),
	);
	const body = (err as TwilioApiError)?.response?.body;
	if (body) {
		runtime.error(info("Response body:"), JSON.stringify(body, null, 2));
	}
}

function ensureTwilioEnv(runtime: RuntimeEnv = defaultRuntime) {
	const required = ["TWILIO_ACCOUNT_SID", "TWILIO_WHATSAPP_FROM"];
	const missing = required.filter((k) => !process.env[k]);
	const hasToken = Boolean(process.env.TWILIO_AUTH_TOKEN);
	const hasKey = Boolean(
		process.env.TWILIO_API_KEY && process.env.TWILIO_API_SECRET,
	);
	if (missing.length > 0 || (!hasToken && !hasKey)) {
		runtime.error(
			danger(
				`Missing Twilio env: ${missing.join(", ") || "auth token or api key/secret"}. Set them in .env before using provider=twilio.`,
			),
		);
		runtime.exit(1);
	}
}

async function pickProvider(pref: Provider | "auto"): Promise<Provider> {
	if (pref !== "auto") return pref;
	const hasWeb = await webAuthExists();
	if (hasWeb) return "web";
	return "twilio";
}

async function monitorTwilio(
	intervalSeconds: number,
	lookbackMinutes: number,
	clientOverride?: ReturnType<typeof createClient>,
	maxIterations = Infinity,
) {
	// Poll Twilio for inbound messages and stream them with de-dupe.
	const env = readEnv();
	const client = clientOverride ?? createClient(env);
	const from = withWhatsAppPrefix(env.whatsappFrom);

	let since = new Date(Date.now() - lookbackMinutes * 60_000);
	const seen = new Set<string>();

	console.log(
		`📡 Monitoring inbound messages to ${from} (poll ${intervalSeconds}s, lookback ${lookbackMinutes}m)`,
	);

	const updateSince = (date?: Date | null) => {
		if (!date) return;
		if (date.getTime() > since.getTime()) {
			since = date;
		}
	};

	let keepRunning = true;
	process.once("SIGINT", () => {
		if (!keepRunning) return;
		keepRunning = false;
		console.log("\n👋 Stopping monitor");
	});

	let iterations = 0;
	while (keepRunning && iterations < maxIterations) {
		try {
			const messages = await client.messages.list({
				to: from,
				dateSentAfter: since,
				limit: 50,
			});

			const inboundMessages = messages
				.filter((m: MessageInstance) => m.direction === "inbound")
				.sort((a: MessageInstance, b: MessageInstance) => {
					const da = a.dateCreated?.getTime() ?? 0;
					const db = b.dateCreated?.getTime() ?? 0;
					return da - db;
				});

			for (const m of inboundMessages) {
				if (seen.has(m.sid)) continue;
				seen.add(m.sid);
				const time = m.dateCreated?.toISOString() ?? "unknown time";
				const fromNum = m.from ?? "unknown sender";
				console.log(`\n[${time}] ${fromNum} -> ${m.to}: ${m.body ?? ""}`);
				updateSince(m.dateCreated);
				void autoReplyIfConfigured(client, m);
			}
		} catch (err) {
			console.error("Error while polling messages", err);
		}

		await sleep(intervalSeconds * 1000);
		iterations += 1;
	}
}

async function monitorWebProvider(
	verbose: boolean,
	listenerFactory = monitorWebInbox,
	keepAlive = true,
	replyResolver: typeof getReplyFromConfig = getReplyFromConfig,
) {
	// Listen for inbound personal WhatsApp Web messages and auto-reply if configured.
	const listener = await listenerFactory({
		verbose,
		onMessage: async (msg) => {
			const ts = msg.timestamp
				? new Date(msg.timestamp).toISOString()
				: new Date().toISOString();
			console.log(`\n[${ts}] ${msg.from} -> ${msg.to}: ${msg.body}`);

			const replyText = await replyResolver(
				{
					Body: msg.body,
					From: msg.from,
					To: msg.to,
					MessageSid: msg.id,
				},
				{
					onReplyStart: msg.sendComposing,
				},
			);
			if (!replyText) return;
			try {
				await msg.reply(replyText);
				if (isVerbose()) {
					console.log(success(`↩️  Auto-replied to ${msg.from} (web)`));
				}
			} catch (err) {
				console.error(
					danger(
						`Failed sending web auto-reply to ${msg.from}: ${String(err)}`,
					),
				);
			}
		},
	});

	console.log(
		info(
			"📡 Listening for personal WhatsApp Web inbound messages. Leave this running; Ctrl+C to stop.",
		),
	);
	process.on("SIGINT", () => {
		void listener.close().finally(() => {
			console.log("\n👋 Web monitor stopped");
			defaultRuntime.exit(0);
		});
	});

	if (keepAlive) {
		await waitForever();
	}
}

async function performSend(
	opts: {
		to: string;
		message: string;
		wait: string;
		poll: string;
		provider: Provider;
	},
	deps: CliDeps,
	_exitFn: (code: number) => never = defaultRuntime.exit,
	_runtime: RuntimeEnv = defaultRuntime,
) {
	deps.assertProvider(opts.provider);
	const waitSeconds = Number.parseInt(opts.wait, 10);
	const pollSeconds = Number.parseInt(opts.poll, 10);

	if (Number.isNaN(waitSeconds) || waitSeconds < 0) {
		throw new Error("Wait must be >= 0 seconds");
	}
	if (Number.isNaN(pollSeconds) || pollSeconds <= 0) {
		throw new Error("Poll must be > 0 seconds");
	}

	if (opts.provider === "web") {
		if (waitSeconds !== 0) {
			console.log(info("Wait/poll are Twilio-only; ignored for provider=web."));
		}
		await deps.sendMessageWeb(opts.to, opts.message, { verbose: isVerbose() });
		return;
	}

	const result = await deps.sendMessage(opts.to, opts.message, runtime);
	if (!result) return;
	if (waitSeconds === 0) return;
	await deps.waitForFinalStatus(
		result.client,
		result.sid,
		waitSeconds,
		pollSeconds,
	);
}

async function performStatus(
	opts: { limit: string; lookback: string; json?: boolean },
	deps: CliDeps,
	_exitFn: (code: number) => never = defaultRuntime.exit,
	_runtime: RuntimeEnv = defaultRuntime,
) {
	const limit = Number.parseInt(opts.limit, 10);
	const lookbackMinutes = Number.parseInt(opts.lookback, 10);
	if (Number.isNaN(limit) || limit <= 0 || limit > 200) {
		throw new Error("limit must be between 1 and 200");
	}
	if (Number.isNaN(lookbackMinutes) || lookbackMinutes <= 0) {
		throw new Error("lookback must be > 0 minutes");
	}

	const messages = await deps.listRecentMessages(lookbackMinutes, limit);
	if (opts.json) {
		console.log(JSON.stringify(messages, null, 2));
		return;
	}
	if (messages.length === 0) {
		console.log("No messages found in the requested window.");
		return;
	}
	for (const m of messages) {
		console.log(formatMessageLine(m));
	}
}

async function performWebhookSetup(
	opts: {
		port: string;
		path: string;
		reply?: string;
		verbose?: boolean;
	},
	deps: CliDeps,
	_exitFn: (code: number) => never = defaultRuntime.exit,
	_runtime: RuntimeEnv = defaultRuntime,
) {
	const port = Number.parseInt(opts.port, 10);
	if (Number.isNaN(port) || port <= 0 || port >= 65536) {
		throw new Error("Port must be between 1 and 65535");
	}
	await deps.ensurePortAvailable(port);

	const server = await deps.startWebhook(
		port,
		opts.path,
		opts.reply,
		Boolean(opts.verbose),
	);
	return server;
}

async function performUp(
	opts: {
		port: string;
		path: string;
		verbose?: boolean;
		yes?: boolean;
	},
	deps: CliDeps,
	_exitFn: (code: number) => never = defaultRuntime.exit,
	_runtime: RuntimeEnv = defaultRuntime,
) {
	const port = Number.parseInt(opts.port, 10);
	if (Number.isNaN(port) || port <= 0 || port >= 65536) {
		throw new Error("Port must be between 1 and 65535");
	}

	await deps.ensurePortAvailable(port);

	// Validate env and binaries
	const env = deps.readEnv(runtime);
	await deps.ensureBinary("tailscale", runExec, runtime);

	// Enable Funnel first so we don't keep a webhook running on failure
	await deps.ensureFunnel(port, runExec, runtime, promptYesNo);
	const host = await deps.getTailnetHostname(runExec);
	const publicUrl = `https://${host}${opts.path}`;
	console.log(`🌐 Public webhook URL (via Funnel): ${publicUrl}`);

	// Start webhook locally (after funnel success)
	const server = await deps.startWebhook(
		port,
		opts.path,
		undefined,
		Boolean(opts.verbose),
	);

	// Configure Twilio sender webhook
	const client = createClient(env);
	const senderSid = await deps.findWhatsappSenderSid(
		client,
		env.whatsappFrom,
		env.whatsappSenderSid,
	);
	await deps.updateWebhook(client, senderSid, publicUrl, "POST", runtime);

	console.log(
		"\nSetup complete. Leave this process running to keep the webhook online. Ctrl+C to stop.",
	);
	return { server, publicUrl, senderSid };
}

type ListedMessage = {
	sid: string;
	status: string | null;
	direction: string | null;
	dateCreated?: Date | null;
	from?: string | null;
	to?: string | null;
	body?: string | null;
	errorCode?: number | null;
	errorMessage?: string | null;
};

function uniqueBySid(messages: ListedMessage[]): ListedMessage[] {
	const seen = new Set<string>();
	const deduped: ListedMessage[] = [];
	for (const m of messages) {
		if (seen.has(m.sid)) continue;
		seen.add(m.sid);
		deduped.push(m);
	}
	return deduped;
}

function sortByDateDesc(messages: ListedMessage[]): ListedMessage[] {
	return [...messages].sort((a, b) => {
		const da = a.dateCreated?.getTime() ?? 0;
		const db = b.dateCreated?.getTime() ?? 0;
		return db - da;
	});
}

function formatMessageLine(m: ListedMessage): string {
	const ts = m.dateCreated?.toISOString() ?? "unknown-time";
	const dir =
		m.direction === "inbound"
			? "⬅️ "
			: m.direction === "outbound-api" || m.direction === "outbound-reply"
				? "➡️ "
				: "↔️ ";
	const status = m.status ?? "unknown";
	const err =
		m.errorCode != null
			? ` error ${m.errorCode}${m.errorMessage ? ` (${m.errorMessage})` : ""}`
			: "";
	const body = (m.body ?? "").replace(/\s+/g, " ").trim();
	const bodyPreview =
		body.length > 140 ? `${body.slice(0, 137)}…` : body || "<empty>";
	return `[${ts}] ${dir}${m.from ?? "?"} -> ${m.to ?? "?"} | ${status}${err} | ${bodyPreview} (sid ${m.sid})`;
}

async function listRecentMessages(
	lookbackMinutes: number,
	limit: number,
	clientOverride?: ReturnType<typeof createClient>,
): Promise<ListedMessage[]> {
	const env = readEnv();
	const client = clientOverride ?? createClient(env);
	const from = withWhatsAppPrefix(env.whatsappFrom);
	const since = new Date(Date.now() - lookbackMinutes * 60_000);

	// Fetch inbound (to our WA number) and outbound (from our WA number), merge, sort, limit.
	const fetchLimit = Math.min(Math.max(limit * 2, limit + 10), 100);
	const inbound = await client.messages.list({
		to: from,
		dateSentAfter: since,
		limit: fetchLimit,
	});
	const outbound = await client.messages.list({
		from,
		dateSentAfter: since,
		limit: fetchLimit,
	});

	const combined = uniqueBySid(
		[...inbound, ...outbound].map((m) => ({
			sid: m.sid,
			status: m.status ?? null,
			direction: m.direction ?? null,
			dateCreated: m.dateCreated,
			from: m.from,
			to: m.to,
			body: m.body,
			errorCode: m.errorCode ?? null,
			errorMessage: m.errorMessage ?? null,
		})),
	);

	return sortByDateDesc(combined).slice(0, limit);
}

program
	.name("warelay")
	.description("WhatsApp relay CLI (Twilio or WhatsApp Web session)")
	.version("1.0.0");

program
	.command("web:login")
	.description("Link your personal WhatsApp via QR (web provider)")
	.option("--verbose", "Verbose connection logs", false)
	.action(async (opts) => {
		setVerbose(Boolean(opts.verbose));
		try {
			await loginWeb(Boolean(opts.verbose));
		} catch (err) {
			defaultRuntime.error(danger(`Web login failed: ${String(err)}`));
			defaultRuntime.exit(1);
		}
	});

program
	.command("send")
	.description("Send a WhatsApp message")
	.requiredOption(
		"-t, --to <number>",
		"Recipient number in E.164 (e.g. +15551234567)",
	)
	.requiredOption("-m, --message <text>", "Message body")
	.option("-w, --wait <seconds>", "Wait for delivery status (0 to skip)", "20")
	.option("-p, --poll <seconds>", "Polling interval while waiting", "2")
	.option("--provider <provider>", "Provider: twilio | web", "twilio")
	.addHelpText(
		"after",
		`
Examples:
  warelay send --to +15551234567 --message "Hi"                # wait 20s for delivery (default)
  warelay send --to +15551234567 --message "Hi" --wait 0       # fire-and-forget
  warelay send --to +15551234567 --message "Hi" --wait 60 --poll 3`,
	)
	.action(async (opts) => {
		const deps = createDefaultDeps();
		try {
			await sendCommand(opts, deps, defaultRuntime);
		} catch (err) {
			defaultRuntime.error(String(err));
			defaultRuntime.exit(1);
		}
	});

program
	.command("relay")
	.description("Auto-reply to inbound messages (auto-selects web or twilio)")
	.option("--provider <provider>", "auto | web | twilio", "auto")
	.option("-i, --interval <seconds>", "Polling interval for twilio mode", "5")
	.option(
		"-l, --lookback <minutes>",
		"Initial lookback window for twilio mode",
		"5",
	)
	.option("--verbose", "Verbose logging", false)
	.addHelpText(
		"after",
		`
Examples:
  warelay relay                     # auto: web if logged-in, else twilio poll
  warelay relay --provider web      # force personal web session
  warelay relay --provider twilio   # force twilio poll
  warelay relay --provider twilio --interval 2 --lookback 30
`,
	)
	.action(async (opts) => {
		setVerbose(Boolean(opts.verbose));
		const providerPref = String(opts.provider ?? "auto");
		if (!["auto", "web", "twilio"].includes(providerPref)) {
			defaultRuntime.error("--provider must be auto, web, or twilio");
			defaultRuntime.exit(1);
		}
		const intervalSeconds = Number.parseInt(opts.interval, 10);
		const lookbackMinutes = Number.parseInt(opts.lookback, 10);
		if (Number.isNaN(intervalSeconds) || intervalSeconds <= 0) {
			defaultRuntime.error("Interval must be a positive integer");
			defaultRuntime.exit(1);
		}
		if (Number.isNaN(lookbackMinutes) || lookbackMinutes < 0) {
			defaultRuntime.error("Lookback must be >= 0 minutes");
			defaultRuntime.exit(1);
		}

		const provider = await pickProvider(providerPref as Provider | "auto");

		if (provider === "web") {
			defaultRuntime.log(info("Provider: web (personal WhatsApp Web session)"));
			try {
				await monitorWebProvider(Boolean(opts.verbose));
				return;
			} catch (err) {
				if (providerPref === "auto") {
					defaultRuntime.error(
						warn("Web session unavailable; falling back to twilio."),
					);
				} else {
					defaultRuntime.error(danger(`Web relay failed: ${String(err)}`));
					defaultRuntime.exit(1);
				}
			}
		}

		ensureTwilioEnv();
		defaultRuntime.log(info("Provider: twilio (polling inbound)"));
		await monitorTwilio(intervalSeconds, lookbackMinutes);
	});

program
	.command("status")
	.description("Show recent WhatsApp messages (sent and received)")
	.option("-l, --limit <count>", "Number of messages to show", "20")
	.option("-b, --lookback <minutes>", "How far back to fetch messages", "240")
	.option("--json", "Output JSON instead of text", false)
	.addHelpText(
		"after",
		`
Examples:
  warelay status                            # last 20 msgs in past 4h
  warelay status --limit 5 --lookback 30    # last 5 msgs in past 30m
  warelay status --json --limit 50          # machine-readable output`,
	)
	.action(async (opts) => {
		const deps = createDefaultDeps();
		try {
			await statusCommand(opts, deps, defaultRuntime);
		} catch (err) {
			defaultRuntime.error(String(err));
			defaultRuntime.exit(1);
		}
	});

program
	.command("webhook")
	.description(
		"Run a local webhook server for inbound WhatsApp (works with Tailscale/port forward)",
	)
	.option("-p, --port <port>", "Port to listen on", "42873")
	.option("-r, --reply <text>", "Optional auto-reply text")
	.option("--path <path>", "Webhook path", "/webhook/whatsapp")
	.option("--verbose", "Log inbound and auto-replies", false)
	.option("-y, --yes", "Auto-confirm prompts when possible", false)
	.addHelpText(
		"after",
		`
Examples:
  warelay webhook                       # listen on 42873
  warelay webhook --port 45000          # pick a high, less-colliding port
  warelay webhook --reply "Got it!"     # static auto-reply; otherwise use config file

With Tailscale:
  tailscale serve tcp 42873 127.0.0.1:42873
  (then set Twilio webhook URL to your tailnet IP:42873/webhook/whatsapp)`,
	)
	// istanbul ignore next
	.action(async (opts) => {
		setVerbose(Boolean(opts.verbose));
		setYes(Boolean(opts.yes));
		const deps = createDefaultDeps();
		try {
			const server = await webhookCommand(opts, deps, defaultRuntime);
			process.on("SIGINT", () => {
				server.close(() => {
					console.log("\n👋 Webhook stopped");
					defaultRuntime.exit(0);
				});
			});
			await deps.waitForever();
		} catch (err) {
			defaultRuntime.error(String(err));
			defaultRuntime.exit(1);
		}
	});

program
	.command("up")
	.description(
		"Bring up webhook + Tailscale Funnel + Twilio callback (default webhook mode)",
	)
	.option("-p, --port <port>", "Port to listen on", "42873")
	.option("--path <path>", "Webhook path", "/webhook/whatsapp")
	.option("--verbose", "Verbose logging during setup/webhook", false)
	.option("-y, --yes", "Auto-confirm prompts when possible", false)
	// istanbul ignore next
	.action(async (opts) => {
		setVerbose(Boolean(opts.verbose));
		setYes(Boolean(opts.yes));
		const deps = createDefaultDeps();
		try {
			const { server } = await upCommand(opts, deps, defaultRuntime);
			process.on("SIGINT", () => {
				server.close(() => {
					console.log("\n👋 Webhook stopped");
					defaultRuntime.exit(0);
				});
			});
			await deps.waitForever();
		} catch (err) {
			defaultRuntime.error(String(err));
			defaultRuntime.exit(1);
		}
	});

export {
	assertProvider,
	autoReplyIfConfigured,
	applyTemplate,
	createClient,
	deriveSessionKey,
	describePortOwner,
	ensureBinary,
	ensureFunnel,
	ensureGoInstalled,
	ensurePortAvailable,
	ensureTailscaledInstalled,
	findIncomingNumberSid,
	findMessagingServiceSid,
	findWhatsappSenderSid,
	formatMessageLine,
	formatTwilioError,
	getReplyFromConfig,
	getTailnetHostname,
	handlePortError,
	logTwilioSendError,
	listRecentMessages,
	loadConfig,
	loadSessionStore,
	monitorTwilio,
	monitorWebProvider,
	normalizeE164,
	PortInUseError,
	promptYesNo,
	createDefaultDeps,
	performSend,
	performStatus,
	performUp,
	performWebhookSetup,
	readEnv,
	resolveStorePath,
	runCommandWithTimeout,
	runExec,
	saveSessionStore,
	sendMessage,
	sendTypingIndicator,
	setMessagingServiceWebhook,
	sortByDateDesc,
	startWebhook,
	updateWebhook,
	uniqueBySid,
	waitForFinalStatus,
	waitForever,
	type toWhatsappJid,
	program,
};

const isMain =
	process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
	program.parseAsync(process.argv);
}
