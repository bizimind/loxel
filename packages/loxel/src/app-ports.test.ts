import { describe, expect, test } from "bun:test";

import { parsePortEnv, vitePort } from "./app-ports";

describe("parsePortEnv", () => {
  test("returns undefined when unset or empty", () => {
    expect(parsePortEnv("P", undefined)).toBeUndefined();
    expect(parsePortEnv("P", "")).toBeUndefined();
  });

  test("parses a port", () => {
    expect(parsePortEnv("P", "7444")).toBe(7444);
  });

  test("throws on anything that is not a port", () => {
    for (const value of ["0", "65536", "-1", "74.4", "7444x", " 7444"]) {
      expect(() => parsePortEnv("P", value)).toThrow(
        `P must be a TCP port (1-65535), not "${value}"`,
      );
    }
  });
});

describe("vitePort", () => {
  test("defaults to 5173 and follows LOXEL_VITE_PORT", () => {
    expect(vitePort({})).toBe(5173);
    expect(vitePort({ LOXEL_VITE_PORT: "5183" })).toBe(5183);
  });
});
