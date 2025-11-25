import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import type { proto } from "@whiskeysockets/baileys";
import {
	DisconnectReason,
	fetchLatestBaileysVersion,
	makeCacheableSignalKeyStore,
	makeWASocket,
	useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import pino from "pino";
import qrcode from "qrcode-terminal";
import { danger, info, isVerbose, logVerbose, success, warn } from "./globals.js";
import { ensureDir, jidToE164, toWhatsappJid } from "./utils.js";
import type { Provider } from "./utils.js";
import { waitForever } from "./cli/wait.js";
import { getReplyFromConfig } from "./auto-reply/reply.js";
import { defaultRuntime, type RuntimeEnv } from "./runtime.js";
import { logInfo, logWarn } from "./logger.js";

const WA_WEB_AUTH_DIR = path.join(os.homedir(), ".warelay", "credentials");

export async function createWaSocket(printQr: boolean, verbose: boolean) {
	const logger = verbose
		? pino({ level: "info" })
		: ({
				level: "silent",
				child: () => ({}) as pino.Logger,
				trace: () => {},
				debug: () => {},
				info: () => {},
				warn: () => {},
				error: () => {},
				fatal: () => {},
			} satisfies Partial<pino.Logger>) as pino.Logger;
	await ensureDir(WA_WEB_AUTH_DIR);
	const { state, saveCreds } = await useMultiFileAuthState(WA_WEB_AUTH_DIR);
	const { version } = await fetchLatestBaileysVersion();
	const sock = makeWASocket({
		auth: {
			creds: state.creds,
			keys: makeCacheableSignalKeyStore(state.keys, logger),
		},
		version,
		logger,
		printQRInTerminal: false,
		browser: ["Warelay", "CLI", "1.0.0"],
		syncFullHistory: false,
		markOnlineOnConnect: false,
	});

	sock.ev.on("creds.update", saveCreds);
	sock.ev.on(
		"connection.update",
		(update: Partial<import("@whiskeysockets/baileys").ConnectionState>) => {
			const { connection, lastDisconnect, qr } = update;
			if (qr && printQr) {
				console.log("Scan this QR in WhatsApp (Linked Devices):");
				qrcode.generate(qr, { small: true });
			}
			if (connection === "close") {
				const status = getStatusCode(lastDisconnect?.error);
				if (status === DisconnectReason.loggedOut) {
					console.error(
						danger("WhatsApp session logged out. Run: warelay web:login"),
					);
				}
			}
			if (connection === "open" && verbose) {
				console.log(success("WhatsApp Web connected."));
			}
		},
	);

	return sock;
}

export async function waitForWaConnection(
	sock: ReturnType<typeof makeWASocket>,
) {
	return new Promise<void>((resolve, reject) => {
		type OffCapable = {
			off?: (event: string, listener: (...args: unknown[]) => void) => void;
		};
		const evWithOff = sock.ev as unknown as OffCapable;

		const handler = (...args: unknown[]) => {
			const update = (args[0] ?? {}) as Partial<
				import("baileys").ConnectionState
			>;
			if (update.connection === "open") {
				evWithOff.off?.("connection.update", handler);
				resolve();
			}
			if (update.connection === "close") {
				evWithOff.off?.("connection.update", handler);
				reject(update.lastDisconnect ?? new Error("Connection closed"));
			}
		};

		sock.ev.on("connection.update", handler);
	});
}

export async function sendMessageWeb(
	to: string,
	body: string,
	options: { verbose: boolean },
): Promise<{ messageId: string; toJid: string }> {
	const sock = await createWaSocket(false, options.verbose);
	try {
		await waitForWaConnection(sock);
		const jid = toWhatsappJid(to);
		try {
			await sock.sendPresenceUpdate("composing", jid);
		} catch (err) {
			logVerbose(`Presence update skipped: ${String(err)}`);
		}
		const result = await sock.sendMessage(jid, { text: body });
		const messageId = result?.key?.id ?? "unknown";
		logInfo(`✅ Sent via web session. Message ID: ${messageId} -> ${jid}`);
		return { messageId, toJid: jid };
	} finally {
		try {
			sock.ws?.close();
		} catch (err) {
			logVerbose(`Socket close failed: ${String(err)}`);
		}
	}
}

export async function loginWeb(
	verbose: boolean,
	waitForConnection: typeof waitForWaConnection = waitForWaConnection,
	runtime: RuntimeEnv = defaultRuntime,
) {
	const sock = await createWaSocket(true, verbose);
	logInfo("Waiting for WhatsApp connection...", runtime);
	try {
		await waitForConnection(sock);
		console.log(success("✅ Linked! Credentials saved for future sends."));
	} catch (err) {
		const code =
			(err as { error?: { output?: { statusCode?: number } } })?.error?.output
				?.statusCode ??
			(err as { output?: { statusCode?: number } })?.output?.statusCode;
		if (code === 515) {
			console.log(
				info(
					"WhatsApp asked for a restart after pairing (code 515); creds are saved. Restarting connection once…",
				),
			);
			try {
				sock.ws?.close();
			} catch {
				// ignore
			}
			const retry = await createWaSocket(false, verbose);
			try {
				await waitForConnection(retry);
				console.log(
					success(
						"✅ Linked after restart; web session ready. You can now send with provider=web.",
					),
				);
				return;
			} finally {
				setTimeout(() => retry.ws?.close(), 500);
			}
		}
		if (code === DisconnectReason.loggedOut) {
			await fs.rm(WA_WEB_AUTH_DIR, { recursive: true, force: true });
			console.error(
				danger(
					"WhatsApp reported the session is logged out. Cleared cached web session; please rerun warelay web:login and scan the QR again.",
				),
			);
			throw new Error("Session logged out; cache cleared. Re-run web:login.");
		}
		const formatted = formatError(err);
		console.error(
			danger(
				`WhatsApp Web connection ended before fully opening. ${formatted}`,
			),
		);
		throw new Error(formatted);
	} finally {
		setTimeout(() => {
			try {
				sock.ws?.close();
			} catch {
				// ignore
			}
		}, 500);
	}
}

export { WA_WEB_AUTH_DIR };

export function webAuthExists() {
	return fs
		.access(WA_WEB_AUTH_DIR)
		.then(() => true)
		.catch(() => false);
}

export type WebInboundMessage = {
	id?: string;
	from: string;
	to: string;
	body: string;
	pushName?: string;
	timestamp?: number;
	sendComposing: () => Promise<void>;
	reply: (text: string) => Promise<void>;
};

export async function monitorWebInbox(options: {
	verbose: boolean;
	onMessage: (msg: WebInboundMessage) => Promise<void>;
}) {
	const sock = await createWaSocket(false, options.verbose);
	await waitForWaConnection(sock);
	const selfJid = sock.user?.id;
	const selfE164 = selfJid ? jidToE164(selfJid) : null;
	const seen = new Set<string>();

	sock.ev.on("messages.upsert", async (upsert) => {
		if (upsert.type !== "notify") return;
		for (const msg of upsert.messages) {
			const id = msg.key?.id ?? undefined;
			// De-dupe on message id; Baileys can emit retries.
			if (id && seen.has(id)) continue;
			if (id) seen.add(id);
			if (msg.key?.fromMe) continue;
			const remoteJid = msg.key?.remoteJid;
			if (!remoteJid) continue;
			// Ignore status/broadcast traffic; we only care about direct chats.
			if (remoteJid.endsWith("@status") || remoteJid.endsWith("@broadcast"))
				continue;
			const from = jidToE164(remoteJid);
			if (!from) continue;
			const body = extractText(msg.message);
			if (!body) continue;
			const chatJid = remoteJid;
			const sendComposing = async () => {
				try {
					await sock.sendPresenceUpdate("composing", chatJid);
				} catch (err) {
					logVerbose(`Presence update failed: ${String(err)}`);
				}
			};
			const reply = async (text: string) => {
				await sock.sendMessage(chatJid, { text });
			};
			const timestamp = msg.messageTimestamp
				? Number(msg.messageTimestamp) * 1000
				: undefined;
			try {
				await options.onMessage({
					id,
					from,
					to: selfE164 ?? "me",
					body,
					pushName: msg.pushName ?? undefined,
					timestamp,
					sendComposing,
					reply,
				});
			} catch (err) {
				console.error(
					danger(`Failed handling inbound web message: ${String(err)}`),
				);
			}
		}
	});

	return {
		close: async () => {
			try {
				sock.ws?.close();
			} catch (err) {
				logVerbose(`Socket close failed: ${String(err)}`);
			}
		},
	};
}

export async function monitorWebProvider(
	verbose: boolean,
	listenerFactory = monitorWebInbox,
	keepAlive = true,
	replyResolver: typeof getReplyFromConfig = getReplyFromConfig,
	runtime: RuntimeEnv = defaultRuntime,
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

	logInfo(
		"📡 Listening for personal WhatsApp Web inbound messages. Leave this running; Ctrl+C to stop.",
		runtime,
	);
	process.on("SIGINT", () => {
		void listener.close().finally(() => {
			logInfo("👋 Web monitor stopped", runtime);
			runtime.exit(0);
		});
	});

	if (keepAlive) {
		await waitForever();
	}
}

function readWebSelfId() {
	// Read the cached WhatsApp Web identity (jid + E.164) from disk if present.
	const credsPath = path.join(WA_WEB_AUTH_DIR, "creds.json");
	try {
		if (!fsSync.existsSync(credsPath)) {
			return { e164: null, jid: null };
		}
		const raw = fsSync.readFileSync(credsPath, "utf-8");
		const parsed = JSON.parse(raw) as { me?: { id?: string } } | undefined;
		const jid = parsed?.me?.id ?? null;
		const e164 = jid ? jidToE164(jid) : null;
		return { e164, jid };
	} catch {
		return { e164: null, jid: null };
	}
}

export function logWebSelfId(
	runtime: RuntimeEnv = defaultRuntime,
	includeProviderPrefix = false,
) {
	// Human-friendly log of the currently linked personal web session.
	const { e164, jid } = readWebSelfId();
	const details =
		e164 || jid
			? `${e164 ?? "unknown"}${jid ? ` (jid ${jid})` : ""}`
			: "unknown";
	const prefix = includeProviderPrefix
		? "Provider: web (personal WhatsApp Web session) — "
		: "";
	runtime.log(info(`${prefix}Listening on web session: ${details}`));
}

export async function pickProvider(pref: Provider | "auto"): Promise<Provider> {
	// Auto-select web when logged in; otherwise fall back to twilio.
	if (pref !== "auto") return pref;
	const hasWeb = await webAuthExists();
	if (hasWeb) return "web";
	return "twilio";
}

function extractText(message: proto.IMessage | undefined): string | undefined {
	if (!message) return undefined;
	if (typeof message.conversation === "string" && message.conversation.trim()) {
		return message.conversation.trim();
	}
	const extended = message.extendedTextMessage?.text;
	if (extended?.trim()) return extended.trim();
	const caption =
		message.imageMessage?.caption ?? message.videoMessage?.caption;
	if (caption?.trim()) return caption.trim();
	return undefined;
}

function getStatusCode(err: unknown) {
	return (
		(err as { output?: { statusCode?: number } })?.output?.statusCode ??
		(err as { status?: number })?.status
	);
}

function formatError(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (typeof err === "string") return err;
	const status = getStatusCode(err);
	const code = (err as { code?: unknown })?.code;
	if (status || code)
		return `status=${status ?? "unknown"} code=${code ?? "unknown"}`;
	return String(err);
}
