import { describe, expect, it, vi } from "vitest";

import { retryAsync } from "./retry.js";

describe("retryAsync", () => {
	it("returns on first success", async () => {
		const fn = vi.fn().mockResolvedValue("ok");
		const result = await retryAsync(fn, 3, 10);
		expect(result).toBe("ok");
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it("retries then succeeds", async () => {
		const fn = vi
			.fn()
			.mockRejectedValueOnce(new Error("fail1"))
			.mockResolvedValueOnce("ok");
		const result = await retryAsync(fn, 3, 1);
		expect(result).toBe("ok");
		expect(fn).toHaveBeenCalledTimes(2);
	});

	it("propagates after exhausting retries", async () => {
		const fn = vi.fn().mockRejectedValue(new Error("boom"));
		await expect(retryAsync(fn, 2, 1)).rejects.toThrow("boom");
		expect(fn).toHaveBeenCalledTimes(2);
	});
});
