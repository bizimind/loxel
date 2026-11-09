import { describe, expect, test } from "bun:test";

import { toLspRange, toMonacoRange } from "./ranges";

describe("ranges", () => {
  test("converts between 0-based LSP and 1-based Monaco ranges both ways", () => {
    const lsp = { start: { line: 0, character: 4 }, end: { line: 2, character: 0 } };
    const monaco = { startLineNumber: 1, startColumn: 5, endLineNumber: 3, endColumn: 1 };
    expect(toMonacoRange(lsp)).toEqual(monaco);
    expect(toLspRange(monaco)).toEqual(lsp);
  });
});
