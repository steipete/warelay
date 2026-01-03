import { describe, expect, it } from "vitest";
import {
  resolveBrowserConfig,
  resolveProfile,
  shouldStartLocalBrowserServer,
} from "./config.js";

describe("browser config", () => {
  it("defaults to enabled with loopback control url and lobster-orange color", () => {
    const resolved = resolveBrowserConfig(undefined);
    expect(resolved.enabled).toBe(true);
    expect(resolved.controlPort).toBe(18791);
    expect(resolved.controlHost).toBe("127.0.0.1");
    expect(resolved.color).toBe("#FF4500");
    expect(shouldStartLocalBrowserServer(resolved)).toBe(true);

    // Default profile uses CDP_PORT_RANGE_START (18800)
    const defaultProfile = resolveProfile(resolved, "clawd");
    expect(defaultProfile?.cdpPort).toBe(18800);
    expect(defaultProfile?.cdpUrl).toBe("http://127.0.0.1:18800");
  });

  it("normalizes hex colors", () => {
    const resolved = resolveBrowserConfig({
      controlUrl: "http://localhost:18791",
      color: "ff4500",
    });
    expect(resolved.color).toBe("#FF4500");
  });

  it("falls back to default color for invalid hex", () => {
    const resolved = resolveBrowserConfig({
      controlUrl: "http://localhost:18791",
      color: "#GGGGGG",
    });
    expect(resolved.color).toBe("#FF4500");
  });

  it("treats non-loopback control urls as remote", () => {
    const resolved = resolveBrowserConfig({
      controlUrl: "http://example.com:18791",
    });
    expect(shouldStartLocalBrowserServer(resolved)).toBe(false);
  });

  it("derives cdpHost from controlUrl", () => {
    const resolved = resolveBrowserConfig({
      controlUrl: "http://127.0.0.1:19000",
    });
    expect(resolved.controlPort).toBe(19000);
    expect(resolved.cdpHost).toBe("127.0.0.1");

    // Default profile uses CDP_PORT_RANGE_START with derived host
    const defaultProfile = resolveProfile(resolved, "clawd");
    expect(defaultProfile?.cdpPort).toBe(18800);
    expect(defaultProfile?.cdpUrl).toBe("http://127.0.0.1:18800");
  });

  it("supports explicit CDP URLs", () => {
    const resolved = resolveBrowserConfig({
      controlUrl: "http://127.0.0.1:18791",
      cdpUrl: "http://example.com:9222",
    });
    // Explicit cdpUrl affects cdpHost and cdpIsLoopback
    expect(resolved.cdpHost).toBe("example.com");
    expect(resolved.cdpIsLoopback).toBe(false);

    // Default profile uses legacy cdpUrl port for backward compatibility
    const defaultProfile = resolveProfile(resolved, "clawd");
    expect(defaultProfile?.cdpUrl).toBe("http://example.com:9222");
  });

  it("rejects unsupported protocols", () => {
    expect(() =>
      resolveBrowserConfig({ controlUrl: "ws://127.0.0.1:18791" }),
    ).toThrow(/must be http/i);
  });

  it("respects legacy cdpUrl port for backward compatibility", () => {
    // Users with existing browser.cdpUrl config should keep working
    const resolved = resolveBrowserConfig({
      controlUrl: "http://127.0.0.1:18791",
      cdpUrl: "http://localhost:9222", // Legacy config pointing to Chrome at 9222
    });

    // Default profile uses legacy cdpUrl port, not the new 18800 range
    const defaultProfile = resolveProfile(resolved, "clawd");
    expect(defaultProfile?.cdpPort).toBe(9222);
    expect(defaultProfile?.cdpUrl).toBe("http://localhost:9222");
  });

  it("uses 18800 for default profile when no cdpUrl configured", () => {
    // Fresh install with no legacy config should use new port range
    const resolved = resolveBrowserConfig({
      controlUrl: "http://127.0.0.1:18791",
    });

    const defaultProfile = resolveProfile(resolved, "clawd");
    expect(defaultProfile?.cdpPort).toBe(18800);
  });
});
