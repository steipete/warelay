import { EventEmitter } from "node:events";
import fsSync from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockBaileysSocket } from "../test/mocks/baileys.js";
import { createMockBaileys } from "../test/mocks/baileys.js";

vi.mock("@whiskeysockets/baileys", () => {
	const created = createMockBaileys();
	(globalThis as Record<PropertyKey, unknown>)[
		Symbol.for("warelay:lastSocket")
	] = created.lastSocket;
	return created.mod;
});

function getLastSocket(): MockBaileysSocket {
	const getter = (globalThis as Record<PropertyKey, unknown>)[
		Symbol.for("warelay:lastSocket")
	];
	if (typeof getter === "function")
		return (getter as () => MockBaileysSocket)();
	if (!getter) throw new Error("Baileys mock not initialized");
	throw new Error("Invalid Baileys socket getter");
}

vi.mock("qrcode-terminal", () => ({
	default: { generate: vi.fn() },
	generate: vi.fn(),
}));

import {
	createWaSocket,
	loginWeb,
	monitorWebInbox,
	logWebSelfId,
	sendMessageWeb,
	waitForWaConnection,
} from "./provider-web.js";

const baileys = (await import(
	"@whiskeysockets/baileys"
)) as unknown as typeof import("@whiskeysockets/baileys") & {
	makeWASocket: ReturnType<typeof vi.fn>;
	useMultiFileAuthState: ReturnType<typeof vi.fn>;
	fetchLatestBaileysVersion: ReturnType<typeof vi.fn>;
	makeCacheableSignalKeyStore: ReturnType<typeof vi.fn>;
};

describe("provider-web", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		const recreated = createMockBaileys();
		(globalThis as Record<PropertyKey, unknown>)[
			Symbol.for("warelay:lastSocket")
		] = recreated.lastSocket;
		baileys.makeWASocket.mockImplementation(recreated.mod.makeWASocket);
		baileys.useMultiFileAuthState.mockImplementation(
			recreated.mod.useMultiFileAuthState,
		);
		baileys.fetchLatestBaileysVersion.mockImplementation(
			recreated.mod.fetchLatestBaileysVersion,
		);
		baileys.makeCacheableSignalKeyStore.mockImplementation(
			recreated.mod.makeCacheableSignalKeyStore,
		);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("creates WA socket with QR handler", async () => {
		await createWaSocket(true, false);
		const makeWASocket = baileys.makeWASocket as ReturnType<typeof vi.fn>;
		expect(makeWASocket).toHaveBeenCalledWith(
			expect.objectContaining({ printQRInTerminal: false }),
		);
		const passed = makeWASocket.mock.calls[0][0];
		const passedLogger = (passed as { logger?: { level?: string; trace?: unknown } })
			.logger;
		expect(passedLogger?.level).toBe("silent");
		expect(typeof passedLogger?.trace).toBe("function");
		const sock = getLastSocket();
		const saveCreds = (
			await baileys.useMultiFileAuthState.mock.results[0].value
		).saveCreds;
		// trigger creds.update listener
		sock.ev.emit("creds.update", {});
		expect(saveCreds).toHaveBeenCalled();
	});

	it("waits for connection open", async () => {
		const ev = new EventEmitter();
		const promise = waitForWaConnection({ ev } as unknown as ReturnType<
			typeof baileys.makeWASocket
		>);
		ev.emit("connection.update", { connection: "open" });
		await expect(promise).resolves.toBeUndefined();
	});

	it("rejects when connection closes", async () => {
		const ev = new EventEmitter();
		const promise = waitForWaConnection({ ev } as unknown as ReturnType<
			typeof baileys.makeWASocket
		>);
		ev.emit("connection.update", {
			connection: "close",
			lastDisconnect: new Error("bye"),
		});
		await expect(promise).rejects.toBeInstanceOf(Error);
	});

	it("sends message via web and closes socket", async () => {
		await sendMessageWeb("+1555", "hi", { verbose: false });
		const sock = getLastSocket();
		expect(sock.sendMessage).toHaveBeenCalled();
		expect(sock.ws.close).toHaveBeenCalled();
	});

	it("loginWeb waits for connection and closes", async () => {
		const closeSpy = vi.fn();
		const ev = new EventEmitter();
		baileys.makeWASocket.mockImplementation(() => ({
			ev,
			ws: { close: closeSpy },
			sendPresenceUpdate: vi.fn(),
			sendMessage: vi.fn(),
		}));
		const waiter: typeof waitForWaConnection = vi
			.fn()
			.mockResolvedValue(undefined);
		await loginWeb(false, waiter);
		await new Promise((resolve) => setTimeout(resolve, 550));
		expect(closeSpy).toHaveBeenCalled();
	});

	it("monitorWebInbox streams inbound messages", async () => {
		const onMessage = vi.fn(async (msg) => {
			await msg.sendComposing();
			await msg.reply("pong");
		});

		const listener = await monitorWebInbox({ verbose: false, onMessage });
		const sock = getLastSocket();
		const upsert = {
			type: "notify",
			messages: [
				{
					key: { id: "abc", fromMe: false, remoteJid: "999@s.whatsapp.net" },
					message: { conversation: "ping" },
					messageTimestamp: 1_700_000_000,
					pushName: "Tester",
				},
			],
		};

		sock.ev.emit("messages.upsert", upsert);
		await new Promise((resolve) => setImmediate(resolve));

		expect(onMessage).toHaveBeenCalledWith(
			expect.objectContaining({ body: "ping", from: "+999", to: "+123" }),
		);
		expect(sock.sendPresenceUpdate).toHaveBeenCalledWith(
			"composing",
			"999@s.whatsapp.net",
		);
		expect(sock.sendMessage).toHaveBeenCalledWith("999@s.whatsapp.net", {
			text: "pong",
		});

		await listener.close();
	});

	it("logWebSelfId prints cached E.164 when creds exist", () => {
		const existsSpy = vi
			.spyOn(fsSync, "existsSync")
			.mockReturnValue(true as never);
		const readSpy = vi
			.spyOn(fsSync, "readFileSync")
			.mockReturnValue(
				JSON.stringify({ me: { id: "12345@s.whatsapp.net" } }),
			);
		const runtime = {
			log: vi.fn(),
			error: vi.fn(),
			exit: vi.fn(),
		};

		logWebSelfId(runtime as never, true);

		expect(runtime.log).toHaveBeenCalledWith(
			"Web Provider: +12345 (jid 12345@s.whatsapp.net)",
		);
		existsSpy.mockRestore();
		readSpy.mockRestore();
	});
});
