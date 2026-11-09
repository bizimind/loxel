import { describe, expect, test } from "bun:test";

import { isInsideTripleQuote } from "./triple-quote-step-over";

/** A single `|` marks the cursor. */
function insideTripleQuote(marked: string, quote: string): boolean {
  const cursor = marked.indexOf("|");
  const line = marked.slice(0, cursor) + marked.slice(cursor + 1);
  return isInsideTripleQuote(line, cursor + 1, quote);
}

describe("isInsideTripleQuote", () => {
  test.each([
    [`"""a"|""`, `"`],
    [`"""a""|"`, `"`],
    [`x = ''|'`, `'`],
  ])("%p", (marked, quote) => {
    expect(insideTripleQuote(marked, quote)).toBe(true);
  });

  test.each([
    [`"""a|"""`, `"`], // at the edge of the run, not inside
    [`""|`, `"`],
    [`"|"`, `"`],
    [`""|""`, `"`],
    [`""""|""`, `"`],
    [`"""a"|""`, `'`],
  ])("not %p", (marked, quote) => {
    expect(insideTripleQuote(marked, quote)).toBe(false);
  });
});
