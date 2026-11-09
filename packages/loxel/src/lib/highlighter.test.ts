import { describe, expect, test } from "bun:test";

import { highlightCode } from "./highlighter";

describe("highlightCode", () => {
  // Diff and hunk views fall back to plain text for a language the highlighter has not loaded.
  test.each([
    ["groovy", "def a = 1"],
    ["bat", "set A=1"],
    ["java-properties", "a=1"],
  ])("highlights %s", async (language, code) => {
    const [line] = await highlightCode(code, language, "github-dark");
    expect(line?.html).toContain("<span");
  });
});
