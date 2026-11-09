import { describe, expect, test } from "bun:test";

import { SEMANTIC_TOKEN_STYLING } from "./monaco-theme";

describe("SEMANTIC_TOKEN_STYLING", () => {
  test.each(["function", "variable", "selfParameter", "string", "comment"])(
    "counts %s, which has a rule of its own",
    (type) => {
      expect(SEMANTIC_TOKEN_STYLING.types.has(type)).toBe(true);
    },
  );

  test.each([
    "macro",
    "modifier",
    "operator",
    "bracket",
    "label",
    "concept",
    "unknown",
    "struct",
    "number",
    "annotationMember",
    "record",
    "recordComponent",
  ])("leaves %s to TextMate", (type) => {
    expect(SEMANTIC_TOKEN_STYLING.types.has(type)).toBe(false);
  });

  test("leaves a type to TextMate when only longer scopes start with it", () => {
    expect(SEMANTIC_TOKEN_STYLING.types.has("punctuation")).toBe(false);
  });

  test("keeps the modifiers rules name, not the ones that only stop a match", () => {
    expect(SEMANTIC_TOKEN_STYLING.modifiers.has("readonly")).toBe(true);
    expect(SEMANTIC_TOKEN_STYLING.modifiers.has("declaration")).toBe(false);
    expect(SEMANTIC_TOKEN_STYLING.modifiers.has("definition")).toBe(false);
    expect(SEMANTIC_TOKEN_STYLING.modifiers.has("static")).toBe(false);
  });
});
