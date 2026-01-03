import type { Request } from "express";
import { describe, expect, it, vi } from "vitest";

import { getProfileContext } from "./utils.js";

describe("getProfileContext", () => {
  const mockCtx = {
    forProfile: vi.fn((name?: string) => ({
      profile: { name: name ?? "clawd", cdpPort: 18800 },
    })),
  };

  it("reads profile from query string", () => {
    const req = {
      query: { profile: "work" },
      body: {},
    } as unknown as Request;

    const result = getProfileContext(req, mockCtx as never);
    expect(mockCtx.forProfile).toHaveBeenCalledWith("work");
    expect(result).toHaveProperty("profile");
  });

  it("reads profile from body when query is empty (POST requests)", () => {
    // This tests the fix for: POST routes ignoring profile in body
    const req = {
      query: {},
      body: { profile: "work" },
    } as unknown as Request;

    mockCtx.forProfile.mockClear();
    const result = getProfileContext(req, mockCtx as never);

    // Fixed: Should call forProfile("work"), not forProfile(undefined)
    expect(mockCtx.forProfile).toHaveBeenCalledWith("work");
    expect(result).toHaveProperty("profile");
  });

  it("prefers query string over body", () => {
    const req = {
      query: { profile: "from-query" },
      body: { profile: "from-body" },
    } as unknown as Request;

    mockCtx.forProfile.mockClear();
    const result = getProfileContext(req, mockCtx as never);

    expect(mockCtx.forProfile).toHaveBeenCalledWith("from-query");
    expect(result).toHaveProperty("profile");
  });
});
