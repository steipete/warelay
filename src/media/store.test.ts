import fs from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const realOs = await vi.importActual<typeof import("node:os")>("node:os");
const HOME = path.join(realOs.tmpdir(), "warelay-home-test");

vi.mock("node:os", () => ({
	default: { homedir: () => HOME },
	homedir: () => HOME,
}));

const store = await import("./store.js");

describe("media store", () => {
	beforeAll(async () => {
		await fs.rm(HOME, { recursive: true, force: true });
	});

	afterAll(async () => {
		await fs.rm(HOME, { recursive: true, force: true });
	});

	it("creates and returns media directory", async () => {
		const dir = await store.ensureMediaDir();
		expect(dir).toContain("warelay-home-test");
		const stat = await fs.stat(dir);
		expect(stat.isDirectory()).toBe(true);
	});

	it("saves buffers and enforces size limit", async () => {
		const buf = Buffer.from("hello");
		const saved = await store.saveMediaBuffer(buf, "text/plain");
		const savedStat = await fs.stat(saved.path);
		expect(savedStat.size).toBe(buf.length);
		expect(saved.contentType).toBe("text/plain");

		const huge = Buffer.alloc(5 * 1024 * 1024 + 1);
		await expect(store.saveMediaBuffer(huge)).rejects.toThrow(
			"Media exceeds 5MB limit",
		);
	});

	it("copies local files and cleans old media", async () => {
		const srcFile = path.join(HOME, "tmp-src.txt");
		await fs.mkdir(HOME, { recursive: true });
		await fs.writeFile(srcFile, "local file");
		const saved = await store.saveMediaSource(srcFile);
		expect(saved.size).toBe(10);
		const savedStat = await fs.stat(saved.path);
		expect(savedStat.isFile()).toBe(true);

		// make the file look old and ensure cleanOldMedia removes it
		const past = Date.now() - 10_000;
		await fs.utimes(saved.path, past / 1000, past / 1000);
		await store.cleanOldMedia(1);
		await expect(fs.stat(saved.path)).rejects.toThrow();
	});
});
