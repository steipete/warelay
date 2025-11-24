import { vi } from "vitest";

export type MockBaileysSocket = {
	ev: import("events").EventEmitter;
	ws: { close: ReturnType<typeof vi.fn> };
	sendPresenceUpdate: ReturnType<typeof vi.fn>;
	sendMessage: ReturnType<typeof vi.fn>;
	user?: { id?: string };
};

export type MockBaileysModule = {
	DisconnectReason: { loggedOut: number };
	fetchLatestBaileysVersion: ReturnType<typeof vi.fn>;
	makeCacheableSignalKeyStore: ReturnType<typeof vi.fn>;
	makeWASocket: ReturnType<typeof vi.fn>;
	useSingleFileAuthState: ReturnType<typeof vi.fn>;
	jidToE164?: (jid: string) => string | null;
	proto?: unknown;
};

export function createMockBaileys(): { mod: MockBaileysModule; lastSocket: () => MockBaileysSocket } {
	const sockets: MockBaileysSocket[] = [];
	const makeWASocket = vi.fn((opts: unknown) => {
		const ev = new (require("events").EventEmitter)();
		const sock: MockBaileysSocket = {
			ev,
			ws: { close: vi.fn() },
			sendPresenceUpdate: vi.fn().mockResolvedValue(undefined),
			sendMessage: vi.fn().mockResolvedValue({ key: { id: "msg123" } }),
			user: { id: "123@s.whatsapp.net" },
		};
		setImmediate(() => ev.emit("connection.update", { connection: "open" }));
		sockets.push(sock);
		return sock;
	});

	const mod: MockBaileysModule = {
		DisconnectReason: { loggedOut: 401 },
		fetchLatestBaileysVersion: vi.fn().mockResolvedValue({ version: [1, 2, 3] }),
		makeCacheableSignalKeyStore: vi.fn((keys: unknown) => keys),
		makeWASocket,
		useSingleFileAuthState: vi.fn(async () => ({
			state: { creds: {}, keys: {} },
			saveState: vi.fn(),
		})),
		jidToE164: (jid: string) => jid.replace(/@.*$/, "").replace(/^/, "+"),
	};

	return {
		mod,
		lastSocket: () => sockets[sockets.length - 1]!,
	};
}
