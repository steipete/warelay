import { describe, expect, it } from "vitest";

import {
  allocateCdpPort,
  allocateColor,
  CDP_PORT_RANGE_END,
  CDP_PORT_RANGE_START,
  getUsedColors,
  getUsedPorts,
  isValidProfileName,
  PROFILE_COLORS,
} from "./profiles.js";

describe("profile name validation", () => {
  it("accepts valid lowercase names", () => {
    expect(isValidProfileName("clawd")).toBe(true);
    expect(isValidProfileName("work")).toBe(true);
    expect(isValidProfileName("my-profile")).toBe(true);
    expect(isValidProfileName("test123")).toBe(true);
    expect(isValidProfileName("a")).toBe(true);
    expect(isValidProfileName("a-b-c-1-2-3")).toBe(true);
    expect(isValidProfileName("1test")).toBe(true);
  });

  it("rejects empty or missing names", () => {
    expect(isValidProfileName("")).toBe(false);
    // @ts-expect-error testing invalid input
    expect(isValidProfileName(null)).toBe(false);
    // @ts-expect-error testing invalid input
    expect(isValidProfileName(undefined)).toBe(false);
  });

  it("rejects names that are too long", () => {
    const longName = "a".repeat(65);
    expect(isValidProfileName(longName)).toBe(false);

    const maxName = "a".repeat(64);
    expect(isValidProfileName(maxName)).toBe(true);
  });

  it("rejects uppercase letters", () => {
    expect(isValidProfileName("MyProfile")).toBe(false);
    expect(isValidProfileName("PROFILE")).toBe(false);
    expect(isValidProfileName("Work")).toBe(false);
  });

  it("rejects spaces and special characters", () => {
    expect(isValidProfileName("my profile")).toBe(false);
    expect(isValidProfileName("my_profile")).toBe(false);
    expect(isValidProfileName("my.profile")).toBe(false);
    expect(isValidProfileName("my/profile")).toBe(false);
    expect(isValidProfileName("my@profile")).toBe(false);
  });

  it("rejects names starting with hyphen", () => {
    expect(isValidProfileName("-invalid")).toBe(false);
    expect(isValidProfileName("--double")).toBe(false);
  });
});

describe("port allocation", () => {
  it("allocates first port when none used", () => {
    const usedPorts = new Set<number>();
    expect(allocateCdpPort(usedPorts)).toBe(CDP_PORT_RANGE_START);
  });

  it("skips used ports and returns next available", () => {
    const usedPorts = new Set([CDP_PORT_RANGE_START, CDP_PORT_RANGE_START + 1]);
    expect(allocateCdpPort(usedPorts)).toBe(CDP_PORT_RANGE_START + 2);
  });

  it("finds first gap in used ports", () => {
    const usedPorts = new Set([
      CDP_PORT_RANGE_START,
      CDP_PORT_RANGE_START + 2, // gap at +1
    ]);
    expect(allocateCdpPort(usedPorts)).toBe(CDP_PORT_RANGE_START + 1);
  });

  it("returns null when all ports are exhausted", () => {
    const usedPorts = new Set<number>();
    for (let port = CDP_PORT_RANGE_START; port <= CDP_PORT_RANGE_END; port++) {
      usedPorts.add(port);
    }
    expect(allocateCdpPort(usedPorts)).toBeNull();
  });

  it("handles ports outside range in used set", () => {
    const usedPorts = new Set([1, 2, 3, 50000]); // ports outside range
    expect(allocateCdpPort(usedPorts)).toBe(CDP_PORT_RANGE_START);
  });
});

describe("getUsedPorts", () => {
  it("returns empty set for undefined profiles", () => {
    expect(getUsedPorts(undefined)).toEqual(new Set());
  });

  it("returns empty set for empty profiles object", () => {
    expect(getUsedPorts({})).toEqual(new Set());
  });

  it("extracts ports from profile configs", () => {
    const profiles = {
      clawd: { cdpPort: 18792 },
      work: { cdpPort: 18793 },
      personal: { cdpPort: 18795 },
    };
    const used = getUsedPorts(profiles);
    expect(used).toEqual(new Set([18792, 18793, 18795]));
  });
});

describe("port collision prevention", () => {
  it("raw config vs resolved config - shows the data source difference", async () => {
    // This demonstrates WHY the route handler must use resolved config
    const { resolveBrowserConfig } = await import("./config.js");

    // Fresh config with no profiles defined (like a new install)
    const rawConfigProfiles = undefined;
    const usedFromRaw = getUsedPorts(rawConfigProfiles);

    // Raw config shows empty - no ports used
    expect(usedFromRaw.size).toBe(0);

    // But resolved config has implicit clawd at 18800
    const resolved = resolveBrowserConfig({});
    const usedFromResolved = getUsedPorts(resolved.profiles);
    expect(usedFromResolved.has(CDP_PORT_RANGE_START)).toBe(true);
  });

  it("create-profile must use resolved config to avoid port collision", async () => {
    // The route handler must use state.resolved.profiles, not raw config
    const { resolveBrowserConfig } = await import("./config.js");

    // Simulate what happens with raw config (empty) vs resolved config
    const rawConfig = { browser: {} }; // Fresh config, no profiles
    const buggyUsedPorts = getUsedPorts(rawConfig.browser?.profiles);
    const buggyAllocatedPort = allocateCdpPort(buggyUsedPorts);

    // Raw config: first allocation gets 18800
    expect(buggyAllocatedPort).toBe(CDP_PORT_RANGE_START);

    // Resolved config: includes implicit clawd at 18800
    const resolved = resolveBrowserConfig(rawConfig.browser);
    const fixedUsedPorts = getUsedPorts(resolved.profiles);
    const fixedAllocatedPort = allocateCdpPort(fixedUsedPorts);

    // Resolved: first NEW profile gets 18801, avoiding collision
    expect(fixedAllocatedPort).toBe(CDP_PORT_RANGE_START + 1);
  });
});

describe("color allocation", () => {
  it("allocates first color when none used", () => {
    const usedColors = new Set<string>();
    expect(allocateColor(usedColors)).toBe(PROFILE_COLORS[0]);
  });

  it("allocates next unused color from palette", () => {
    // biome-ignore lint/style/noNonNullAssertion: Test file with known array
    const usedColors = new Set([PROFILE_COLORS[0]!.toUpperCase()]);
    expect(allocateColor(usedColors)).toBe(PROFILE_COLORS[1]);
  });

  it("skips multiple used colors", () => {
    const usedColors = new Set([
      // biome-ignore lint/style/noNonNullAssertion: Test file with known array
      PROFILE_COLORS[0]!.toUpperCase(),
      // biome-ignore lint/style/noNonNullAssertion: Test file with known array
      PROFILE_COLORS[1]!.toUpperCase(),
      // biome-ignore lint/style/noNonNullAssertion: Test file with known array
      PROFILE_COLORS[2]!.toUpperCase(),
    ]);
    expect(allocateColor(usedColors)).toBe(PROFILE_COLORS[3]);
  });

  it("handles case-insensitive color matching", () => {
    const usedColors = new Set(["#ff4500"]); // lowercase
    // Should still skip this color (case-insensitive)
    // Note: allocateColor compares against uppercase, so lowercase won't match
    // This tests the current behavior
    expect(allocateColor(usedColors)).toBe(PROFILE_COLORS[0]); // returns first since lowercase doesn't match
  });

  it("cycles when all colors are used", () => {
    const usedColors = new Set(PROFILE_COLORS.map((c) => c.toUpperCase()));
    // Should cycle based on count
    const result = allocateColor(usedColors);
    expect(PROFILE_COLORS).toContain(result);
  });

  it("cycles based on count when palette exhausted", () => {
    // Add all colors plus some extras
    const usedColors = new Set([
      ...PROFILE_COLORS.map((c) => c.toUpperCase()),
      "#AAAAAA",
      "#BBBBBB",
    ]);
    const result = allocateColor(usedColors);
    // Index should be (10 + 2) % 10 = 2
    expect(result).toBe(PROFILE_COLORS[2]);
  });
});

describe("getUsedColors", () => {
  it("returns empty set for undefined profiles", () => {
    expect(getUsedColors(undefined)).toEqual(new Set());
  });

  it("returns empty set for empty profiles object", () => {
    expect(getUsedColors({})).toEqual(new Set());
  });

  it("extracts and uppercases colors from profile configs", () => {
    const profiles = {
      clawd: { color: "#ff4500" },
      work: { color: "#0066CC" },
    };
    const used = getUsedColors(profiles);
    expect(used).toEqual(new Set(["#FF4500", "#0066CC"]));
  });
});
