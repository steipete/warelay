import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { proto } from "@whiskeysockets/baileys";
import {
	type AnyMessageContent,
	DisconnectReason,
	downloadMediaMessage,
	fetchLatestBaileysVersion,
	makeCacheableSignalKeyStore,
	makeWASocket,
	useMultiFileAuthState,
	type WAMessage,
} from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import { getReplyFromConfig } from "./auto-reply/reply.js";
import { waitForever } from "./cli/wait.js";
import { danger, info, isVerbose, logVerbose, success } from "./globals.js";
import { logInfo } from "./logger.js";
import { getChildLogger } from "./logging.js";
import { saveMediaBuffer } from "./media/store.js";
import { defaultRuntime, type RuntimeEnv } from "./runtime.js";
import type { Provider } from "./utils.js";
import { ensureDir, jidToE164, toWhatsappJid } from "./utils.js";

function formatDuration(ms: number) {
	return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`;
}

const WA_WEB_AUTH_DIR = path.join(os.homedir(), ".warelay", "credentials");

export async function createWaSocket(printQr: boolean, verbose: boolean) {
	const logger = getChildLogger(
		{ module: "baileys" },
		{
			level: verbose ? "info" : "silent",
		},
	);
	// Some Baileys internals call logger.trace even when silent; ensure it's present.
	const loggerAny = logger as unknown as Record<string, unknown>;
	if (typeof loggerAny.trace !== "function") {
		loggerAny.trace = () => {};
	}
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
		browser: ["warelay", "cli", "0.1.3"],
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
						danger("WhatsApp session logged out. Run: warelay login"),
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
				import("@whiskeysockets/baileys").ConnectionState
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
	options: { verbose: boolean; mediaUrl?: string },
): Promise<{ messageId: string; toJid: string }> {
	const sock = await createWaSocket(false, options.verbose);
	try {
		logInfo("🔌 Connecting to WhatsApp Web…");
		await waitForWaConnection(sock);
		const jid = toWhatsappJid(to);
		try {
			await sock.sendPresenceUpdate("composing", jid);
		} catch (err) {
			logVerbose(`Presence update skipped: ${String(err)}`);
		}
		let payload: AnyMessageContent = { text: body };
		if (options.mediaUrl) {
			const media = await loadWebMedia(options.mediaUrl);
			payload = {
				image: media.buffer,
				caption: body || undefined,
				mimetype: media.contentType,
			};
		}
		logInfo(
			`📤 Sending via web session -> ${jid}${options.mediaUrl ? " (media)" : ""}`,
		);
		const result = await sock.sendMessage(jid, payload);
		const messageId = result?.key?.id ?? "unknown";
		logInfo(
			`✅ Sent via web session. Message ID: ${messageId} -> ${jid}${options.mediaUrl ? " (media)" : ""}`,
		);
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
					"WhatsApp reported the session is logged out. Cleared cached web session; please rerun warelay login and scan the QR again.",
				),
			);
			throw new Error("Session logged out; cache cleared. Re-run login.");
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
	sendMedia: (payload: {
		image: Buffer;
		caption?: string;
		mimetype?: string;
	}) => Promise<void>;
	mediaPath?: string;
	mediaType?: string;
	mediaUrl?: string;
};

export async function monitorWebInbox(options: {
	verbose: boolean;
	onMessage: (msg: WebInboundMessage) => Promise<void>;
}) {
	const inboundLogger = getChildLogger({ module: "web-inbound" });
	const sock = await createWaSocket(false, options.verbose);
	await waitForWaConnection(sock);
	try {
		// Advertise that the relay is online right after connecting.
		await sock.sendPresenceUpdate("available");
		if (isVerbose()) logVerbose("Sent global 'available' presence on connect");
	} catch (err) {
		logVerbose(
			`Failed to send 'available' presence on connect: ${String(err)}`,
		);
	}
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
			if (id) {
				const participant = msg.key?.participant;
				try {
					await sock.readMessages([
						{ remoteJid, id, participant, fromMe: false },
					]);
					if (isVerbose()) {
						const suffix = participant ? ` (participant ${participant})` : "";
						logVerbose(
							`Marked message ${id} as read for ${remoteJid}${suffix}`,
						);
					}
				} catch (err) {
					logVerbose(`Failed to mark message ${id} read: ${String(err)}`);
				}
			}
			const from = jidToE164(remoteJid);
			if (!from) continue;
			let body = extractText(msg.message ?? undefined);
			if (!body) {
				body = extractMediaPlaceholder(msg.message ?? undefined);
				if (!body) continue;
			}
			let mediaPath: string | undefined;
			let mediaType: string | undefined;
			try {
				const inboundMedia = await downloadInboundMedia(msg, sock);
				if (inboundMedia) {
					const saved = await saveMediaBuffer(
						inboundMedia.buffer,
						inboundMedia.mimetype,
					);
					mediaPath = saved.path;
					mediaType = inboundMedia.mimetype;
				}
			} catch (err) {
				logVerbose(`Inbound media download failed: ${String(err)}`);
			}
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
			const sendMedia = async (payload: {
				image: Buffer;
				caption?: string;
				mimetype?: string;
			}) => {
				await sock.sendMessage(chatJid, payload);
			};
			const timestamp = msg.messageTimestamp
				? Number(msg.messageTimestamp) * 1000
				: undefined;
			inboundLogger.info(
				{
					from,
					to: selfE164 ?? "me",
					body,
					mediaPath,
					mediaType,
					timestamp,
				},
				"inbound message",
			);
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
					sendMedia,
					mediaPath,
					mediaType,
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
	const replyLogger = getChildLogger({ module: "web-auto-reply" });
	// Listen for inbound personal WhatsApp Web messages and auto-reply if configured.
	const listener = await listenerFactory({
		verbose,
		onMessage: async (msg) => {
			const ts = msg.timestamp
				? new Date(msg.timestamp).toISOString()
				: new Date().toISOString();
			console.log(`\n[${ts}] ${msg.from} -> ${msg.to}: ${msg.body}`);

			const replyStarted = Date.now();
			const replyResult = await replyResolver(
				{
					Body: msg.body,
					From: msg.from,
					To: msg.to,
					MessageSid: msg.id,
					MediaPath: msg.mediaPath,
					MediaUrl: msg.mediaUrl,
					MediaType: msg.mediaType,
				},
				{
					onReplyStart: msg.sendComposing,
				},
			);
			if (!replyResult || (!replyResult.text && !replyResult.mediaUrl)) {
				logVerbose("Skipping auto-reply: no text/media returned from resolver");
				return;
			}
			try {
				if (replyResult.mediaUrl) {
					logVerbose(`Web auto-reply media detected: ${replyResult.mediaUrl}`);
					try {
						const media = await loadWebMedia(replyResult.mediaUrl);
						if (isVerbose()) {
							logVerbose(
								`Web auto-reply media size: ${(media.buffer.length / (1024 * 1024)).toFixed(2)}MB`,
							);
						}
						await msg.sendMedia({
							image: media.buffer,
							caption: replyResult.text || undefined,
							mimetype: media.contentType,
						});
						logInfo(
							`✅ Sent web media reply to ${msg.from} (${(media.buffer.length / (1024 * 1024)).toFixed(2)}MB)`,
							runtime,
						);
						replyLogger.info(
							{
								to: msg.from,
								from: msg.to,
								text: replyResult.text ?? null,
								mediaUrl: replyResult.mediaUrl,
								mediaSizeBytes: media.buffer.length,
								durationMs: Date.now() - replyStarted,
							},
							"auto-reply sent (media)",
						);
					} catch (err) {
						console.error(
							danger(`Failed sending web media to ${msg.from}: ${String(err)}`),
						);
						if (replyResult.text) {
							await msg.reply(replyResult.text);
							logInfo(
								`⚠️  Media skipped; sent text-only to ${msg.from}`,
								runtime,
							);
							replyLogger.info(
								{
									to: msg.from,
									from: msg.to,
									text: replyResult.text,
									mediaUrl: replyResult.mediaUrl,
									durationMs: Date.now() - replyStarted,
									mediaSendFailed: true,
								},
								"auto-reply sent (text fallback)",
							);
						}
					}
				} else {
					await msg.reply(replyResult.text ?? "");
				}
				const durationMs = Date.now() - replyStarted;
				if (isVerbose()) {
					console.log(
						success(
							`↩️  Auto-replied to ${msg.from} (web, ${replyResult.text?.length ?? 0} chars${replyResult.mediaUrl ? ", media" : ""}, ${formatDuration(durationMs)})`,
						),
					);
				} else {
					console.log(
						success(
							`↩️  ${replyResult.text ?? "<media>"}${replyResult.mediaUrl ? " (media)" : ""}`,
						),
					);
				}
				replyLogger.info(
					{
						to: msg.from,
						from: msg.to,
						text: replyResult.text ?? null,
						mediaUrl: replyResult.mediaUrl,
						durationMs,
					},
					"auto-reply sent",
				);
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
	const prefix = includeProviderPrefix ? "Web Provider: " : "";
	runtime.log(info(`${prefix}${details}`));
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

function extractMediaPlaceholder(
	message: proto.IMessage | undefined,
): string | undefined {
	if (!message) return undefined;
	if (message.imageMessage) return "<media:image>";
	if (message.videoMessage) return "<media:video>";
	if (message.audioMessage) return "<media:audio>";
	if (message.documentMessage) return "<media:document>";
	if (message.stickerMessage) return "<media:sticker>";
	return undefined;
}

async function downloadInboundMedia(
	msg: proto.IWebMessageInfo,
	sock: ReturnType<typeof makeWASocket>,
): Promise<{ buffer: Buffer; mimetype?: string } | undefined> {
	const message = msg.message;
	if (!message) return undefined;
	const mimetype =
		message.imageMessage?.mimetype ??
		message.videoMessage?.mimetype ??
		message.documentMessage?.mimetype ??
		message.audioMessage?.mimetype ??
		message.stickerMessage?.mimetype ??
		undefined;
	if (
		!message.imageMessage &&
		!message.videoMessage &&
		!message.documentMessage &&
		!message.audioMessage &&
		!message.stickerMessage
	) {
		return undefined;
	}
	try {
		const buffer = (await downloadMediaMessage(
			msg as WAMessage,
			"buffer",
			{},
			{
				reuploadRequest: sock.updateMediaMessage,
				logger: sock.logger,
			},
		)) as Buffer;
		return { buffer, mimetype };
	} catch (err) {
		logVerbose(`downloadMediaMessage failed: ${String(err)}`);
		return undefined;
	}
}

async function loadWebMedia(
	mediaUrl: string,
): Promise<{ buffer: Buffer; contentType?: string }> {
	const MAX_WEB_BYTES = 16 * 1024 * 1024; // 16MB: web provider can handle larger than Twilio
	if (mediaUrl.startsWith("file://")) {
		mediaUrl = mediaUrl.replace("file://", "");
	}
	if (/^https?:\/\//i.test(mediaUrl)) {
		const res = await fetch(mediaUrl);
		if (!res.ok || !res.body) {
			throw new Error(`Failed to fetch media: HTTP ${res.status}`);
		}
		const array = Buffer.from(await res.arrayBuffer());
		if (array.length > MAX_WEB_BYTES) {
			throw new Error(
				`Media exceeds ${Math.floor(MAX_WEB_BYTES / (1024 * 1024))}MB limit (got ${(
					array.length / (1024 * 1024)
				).toFixed(1)}MB)`,
			);
		}
		return {
			buffer: array,
			contentType: res.headers.get("content-type") ?? undefined,
		};
	}
	// Local path
	const data = await fs.readFile(mediaUrl);
	if (data.length > MAX_WEB_BYTES) {
		throw new Error(
			`Media exceeds ${Math.floor(MAX_WEB_BYTES / (1024 * 1024))}MB limit (got ${(
				data.length / (1024 * 1024)
			).toFixed(1)}MB)`,
		);
	}
	return { buffer: data };
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
