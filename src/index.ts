#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process, { stdin as input, stdout as output } from "node:process";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

import chalk from "chalk";
import dotenv from "dotenv";
import JSON5 from "json5";
import Twilio from "twilio";
import type { MessageInstance } from "twilio/lib/rest/api/v2010/account/message.js";
import type { TwilioSenderListClient, TwilioRequester } from "./twilio/types.js";
import {
	runCommandWithTimeout,
	runExec,
	type SpawnResult,
} from "./process/exec.js";
import { defaultRuntime, type RuntimeEnv } from "./runtime.js";
import { sendTypingIndicator } from "./twilio/typing.js";
import {
	autoReplyIfConfigured,
	getReplyFromConfig,
} from "./auto-reply/reply.js";
import { readEnv, ensureTwilioEnv, type EnvConfig } from "./env.js";
import { createClient } from "./twilio/client.js";
import { logTwilioSendError, formatTwilioError } from "./twilio/utils.js";
import { monitorTwilio as monitorTwilioImpl } from "./twilio/monitor.js";
import { sendMessage, waitForFinalStatus } from "./twilio/send.js";
import { startWebhook as startWebhookImpl } from "./twilio/webhook.js";
import {
	updateWebhook as updateWebhookImpl,
	findIncomingNumberSid as findIncomingNumberSidImpl,
	findMessagingServiceSid as findMessagingServiceSidImpl,
	setMessagingServiceWebhook as setMessagingServiceWebhookImpl,
} from "./twilio/update-webhook.js";
import {
	listRecentMessages,
	formatMessageLine,
	uniqueBySid,
	sortByDateDesc,
} from "./twilio/messages.js";
import { CLAUDE_BIN, parseClaudeJsonText } from "./auto-reply/claude.js";
import {
	applyTemplate,
	type MsgContext,
	type TemplateContext,
} from "./auto-reply/templating.js";
import {
	CONFIG_PATH,
	type WarelayConfig,
	type SessionConfig,
	type SessionScope,
	type ReplyMode,
	type ClaudeOutputFormat,
	loadConfig,
} from "./config/config.js";
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
	WA_WEB_AUTH_DIR,
	webAuthExists,
} from "./provider-web.js";
import type { Provider } from "./utils.js";
import {
	assertProvider,
	CONFIG_DIR,
	jidToE164,
	normalizeE164,
	normalizePath,
	sleep,
	toWhatsappJid,
	withWhatsAppPrefix,
} from "./utils.js";
import {
	DEFAULT_IDLE_MINUTES,
	DEFAULT_RESET_TRIGGER,
	deriveSessionKey,
	loadSessionStore,
	resolveStorePath,
	saveSessionStore,
	SESSION_STORE_DEFAULT,
} from "./config/sessions.js";

dotenv.config({ quiet: true });

import { buildProgram } from "./cli/program.js";

const program = buildProgram();

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

// sendMessage / waitForFinalStatus now live in src/twilio/send.ts and are imported above.

// startWebhook now lives in src/twilio/webhook.ts; keep shim for existing imports/tests.
async function startWebhook(
	port: number,
	path = "/webhook/whatsapp",
	autoReply: string | undefined,
	verbose: boolean,
	runtime: RuntimeEnv = defaultRuntime,
): Promise<import("http").Server> {
	return startWebhookImpl(port, path, autoReply, verbose, runtime);
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



async function setMessagingServiceWebhook(
	client: TwilioSenderListClient,
	url: string,
	method: "POST" | "GET" = "POST",
): Promise<boolean> {
	return setMessagingServiceWebhookImpl(client, url, method);
}


async function updateWebhook(
	client: ReturnType<typeof createClient>,
	senderSid: string,
	url: string,
	method: "POST" | "GET" = "POST",
	runtime: RuntimeEnv = defaultRuntime,
) {
	return updateWebhookImpl(client, senderSid, url, method, runtime);
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

function readWebSelfId() {
	const credsPath = path.join(WA_WEB_AUTH_DIR, "creds.json");
	try {
		if (!fs.existsSync(credsPath)) {
			return { e164: null, jid: null };
		}
		const raw = fs.readFileSync(credsPath, "utf-8");
		const parsed = JSON.parse(raw) as { me?: { id?: string } } | undefined;
		const jid = parsed?.me?.id ?? null;
		const e164 = jid ? jidToE164(jid) : null;
		return { e164, jid };
	} catch {
		return { e164: null, jid: null };
	}
}

function logWebSelfId(runtime: RuntimeEnv = defaultRuntime) {
	const { e164, jid } = readWebSelfId();
	const details =
		e164 || jid
			? `${e164 ?? "unknown"}${jid ? ` (jid ${jid})` : ""}`
			: "unknown";
	runtime.log(info(`Listening on web session: ${details}`));
}

function logTwilioFrom(runtime: RuntimeEnv = defaultRuntime) {
	const env = readEnv(runtime);
	runtime.log(
		info(`Provider: twilio (polling inbound) | from ${env.whatsappFrom}`),
	);
}

async function monitorTwilio(
	intervalSeconds: number,
	lookbackMinutes: number,
	clientOverride?: ReturnType<typeof createClient>,
	maxIterations = Infinity,
) {
	// Delegate to the refactored monitor in src/twilio/monitor.ts.
	return monitorTwilioImpl(
		intervalSeconds,
		lookbackMinutes,
		{
			client: clientOverride,
			maxIterations,
			deps: {
				autoReplyIfConfigured,
				listRecentMessages,
				readEnv,
				createClient,
				sleep,
			},
			runtime: defaultRuntime,
		},
	);
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
	findIncomingNumberSidImpl as findIncomingNumberSid,
	findMessagingServiceSidImpl as findMessagingServiceSid,
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
	toWhatsappJid,
	program,
};

const isMain =
	process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
	program.parseAsync(process.argv);
}
