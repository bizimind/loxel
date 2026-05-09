import { describe, expect, test } from "bun:test";

import { detectPreferredProvider, detectProviders } from "../src/detect.ts";

describe("detectProviders", () => {
  test("returns an array", () => {
    const providers = detectProviders();
    expect(Array.isArray(providers)).toBe(true);
  });

  test("only includes valid provider types", () => {
    const validTypes = new Set(["apple", "podman", "docker"]);
    for (const provider of detectProviders()) {
      expect(validTypes.has(provider)).toBe(true);
    }
  });
});

describe("detectPreferredProvider", () => {
  test("returns a string or null", () => {
    const result = detectPreferredProvider();
    expect(result === null || typeof result === "string").toBe(true);
  });
});
