import { describe, expect, test } from "bun:test";

import { collectWebSourcesFromToolOutput, ensureSourcesSection } from "../src/orchestrator/loop.ts";

describe("citation enforcement helpers", () => {
  test("collects urls from WebSearch output", () => {
    const urls = collectWebSourcesFromToolOutput("WebSearch", {
      results: [
        { title: "A", url: "https://example.com/a", snippet: "s" },
        { title: "B", url: "https://example.com/b", snippet: "s" },
      ],
    });
    expect(urls).toEqual(["https://example.com/a", "https://example.com/b"]);
  });

  test("appends Sources section if missing", () => {
    const text = ensureSourcesSection("Answer text", [
      "https://example.com/a",
      "https://example.com/b",
    ]);
    expect(text.includes("Sources:")).toBe(true);
    expect(text.includes("[https://example.com/a](https://example.com/a)")).toBe(true);
  });

  test("does not duplicate Sources section when already present", () => {
    const original = "Answer\n\nSources:\n- [x](https://example.com)";
    const next = ensureSourcesSection(original, ["https://example.com/b"]);
    expect(next).toBe(original);
  });
});
