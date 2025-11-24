import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockBaileysSocket } from "../test/mocks/baileys.js";
import { createMockBaileys } from "../test/mocks/baileys.js";

const LAST_SOCKET_KEY = Symbol.for("warelay:lastSocket");

vi.mock("baileys", () => {
	const created = createMockBaileys();
	(globalThis as Record<PropertyKey, unknown>)[LAST_SOCKET_KEY] =
		created.lastSocket;
	return created.mod;
});

function getLastSocket(): MockBaileysSocket {
	const getter = (globalThis as Record<PropertyKey, unknown>)[LAST_SOCKET_KEY];
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
	sendMessageWeb,
	waitForWaConnection,
} from "./provider-web.js";

const baileys = (await import(
	"baileys"
)) as unknown as typeof import("baileys") & {
	makeWASocket: ReturnType<typeof vi.fn>;
	useSingleFileAuthState: ReturnType<typeof vi.fn>;
	fetchLatestBaileysVersion: ReturnType<typeof vi.fn>;
	makeCacheableSignalKeyStore: ReturnType<typeof vi.fn>;
};

describe("provider-web", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		const recreated = createMockBaileys();
		(globalThis as Record<PropertyKey, unknown>)[LAST_SOCKET_KEY] =
			recreated.lastSocket;
		baileys.makeWASocket.mockImplementation(recreated.mod.makeWASocket);
		baileys.useSingleFileAuthState.mockImplementation(
			recreated.mod.useSingleFileAuthState,
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
		const sock = getLastSocket();
		const saveCreds = (
			await baileys.useSingleFileAuthState.mock.results[0].value
		).saveState;
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
});
