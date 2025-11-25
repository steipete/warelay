import fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const MEDIA_DIR = path.join(process.cwd(), "tmp-media-test");
const cleanOldMedia = vi.fn().mockResolvedValue(undefined);

vi.mock("./store.js", () => ({
	getMediaDir: () => MEDIA_DIR,
	cleanOldMedia,
}));

const { startMediaServer } = await import("./server.js");

describe("media server", () => {
	beforeAll(async () => {
		await fs.rm(MEDIA_DIR, { recursive: true, force: true });
		await fs.mkdir(MEDIA_DIR, { recursive: true });
	});

	afterAll(async () => {
		await fs.rm(MEDIA_DIR, { recursive: true, force: true });
	});

	it("serves media and cleans up after send", async () => {
		const file = path.join(MEDIA_DIR, "file1");
		await fs.writeFile(file, "hello");
		const server = await startMediaServer(0, 5_000);
		const port = (server.address() as AddressInfo).port;
		const res = await fetch(`http://localhost:${port}/media/file1`);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("hello");
		await new Promise((r) => setTimeout(r, 600));
		await expect(fs.stat(file)).rejects.toThrow();
		await new Promise((r) => server.close(r));
	});

	it("expires old media", async () => {
		const file = path.join(MEDIA_DIR, "old");
		await fs.writeFile(file, "stale");
		const past = Date.now() - 10_000;
		await fs.utimes(file, past / 1000, past / 1000);
		const server = await startMediaServer(0, 1_000);
		const port = (server.address() as AddressInfo).port;
		const res = await fetch(`http://localhost:${port}/media/old`);
		expect(res.status).toBe(410);
		await expect(fs.stat(file)).rejects.toThrow();
		await new Promise((r) => server.close(r));
	});
});
