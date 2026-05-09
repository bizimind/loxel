import { describe, expect, test } from "bun:test";

import {
  buildCapabilityFallbackHints,
  intersectWithDeclared,
  normalizeDeclaredTools,
} from "../src/tools/capabilities.ts";

describe("tool capabilities helpers", () => {
  test("normalizes declared tools and aliases", () => {
    const declared = normalizeDeclaredTools(["Read", "WriteTodo", "Unknown"]);
    expect(declared).toEqual(["Read", "TodoWrite"]);
  });

  test("intersects allowed and declared tools", () => {
    const result = intersectWithDeclared(["Read", "Write", "ToolSearch"], ["Read", "ToolSearch"]);
    expect(result).toEqual(["Read", "ToolSearch"]);
  });

  test("builds fallback hints", () => {
    const hints = buildCapabilityFallbackHints(["Read", "Glob"]);
    expect(hints.some((hint) => hint.includes("LS"))).toBe(true);
  });
});
