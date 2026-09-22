import { describe, expect, it } from "bun:test";

import { DefaultLinesDiffComputer } from "monaco-editor/editor/common/diff/defaultLinesDiffComputer/defaultLinesDiffComputer";

import type { ChangePair } from "./change-regions";
import { buildInlineChangesForPairs, computeInlineChanges, rangesByLine } from "./inline-changes";

function slice(line: string, r: { startColumn: number; endColumn: number }): string {
  return line.slice(r.startColumn - 1, r.endColumn - 1);
}

describe("Monaco DefaultLinesDiffComputer (internal module shape)", () => {
  // The module is untyped upstream; this guards the surface declared in
  // monaco-lines-diff-computer.d.ts so a Monaco upgrade that renames it fails here, not silently.
  it("exposes computeDiff returning changes with innerChanges and a hitTimeout flag", () => {
    const result = new DefaultLinesDiffComputer().computeDiff(["a b"], ["a c"], {
      ignoreTrimWhitespace: false,
      maxComputationTimeMs: 1000,
      computeMoves: false,
    });
    expect(typeof result.hitTimeout).toBe("boolean");
    expect(result.hitTimeout).toBe(false);
    expect(Array.isArray(result.changes)).toBe(true);
    const inner = result.changes[0]?.innerChanges?.[0];
    expect(inner?.originalRange).toEqual({
      startLineNumber: 1,
      startColumn: 3,
      endLineNumber: 1,
      endColumn: 4,
    });
    expect(inner?.modifiedRange).toEqual({
      startLineNumber: 1,
      startColumn: 3,
      endLineNumber: 1,
      endColumn: 4,
    });
  });
});

describe("computeInlineChanges", () => {
  it("highlights whole replaced tokens", () => {
    const oldLine = "const foo = 5;";
    const newLine = "const bar = 42;";
    const { old, new: updated } = computeInlineChanges([oldLine], [newLine]);
    expect(old.map((r) => slice(oldLine, r))).toEqual(["foo", "5"]);
    expect(updated.map((r) => slice(newLine, r))).toEqual(["bar", "42"]);
  });

  it("keeps single-character edits at character granularity", () => {
    const plural = computeInlineChanges(["items.push(x)"], ["item.push(x)"]);
    expect(plural.old.map((r) => slice("items.push(x)", r))).toEqual(["s"]);
    expect(plural.new).toEqual([]);

    const spelling = computeInlineChanges(["let color = 1"], ["let colour = 1"]);
    expect(spelling.old).toEqual([]);
    expect(spelling.new.map((r) => slice("let colour = 1", r))).toEqual(["u"]);
  });

  it("handles blocks with unequal line counts", () => {
    const oldLines = ["return a;"];
    const newLines = ["const b = a;", "return b;"];
    const { old, new: updated } = computeInlineChanges(oldLines, newLines);
    expect(old.length).toBeGreaterThan(0);
    expect(updated.length).toBeGreaterThan(0);
    for (const r of updated) {
      expect(r.startLineNumber).toBeGreaterThanOrEqual(1);
      expect(r.endLineNumber).toBeLessThanOrEqual(2);
    }
  });

  it("returns nothing for near-total rewrites", () => {
    const result = computeInlineChanges(
      ["function alpha() {", "  return 1;", "}"],
      ["export const omega = async (value) => value * 2;", "// unrelated", "const z = [];"],
    );
    expect(result).toEqual({ old: [], new: [] });
  });

  it("returns nothing when either side is empty", () => {
    expect(computeInlineChanges([], ["a"])).toEqual({ old: [], new: [] });
    expect(computeInlineChanges(["a"], [])).toEqual({ old: [], new: [] });
  });
});

describe("buildInlineChangesForPairs", () => {
  it("offsets ranges to absolute file lines and skips non-modify pairs", () => {
    const oldLines = ["a", "b", "const foo = 5;", "d"];
    const newLines = ["a", "b", "const bar = 5;", "d", "added"];
    const pairs: ChangePair[] = [
      { type: "modify", oldStart: 3, oldEnd: 3, newStart: 3, newEnd: 3 },
      { type: "add", oldStart: 4, oldEnd: 4, newStart: 5, newEnd: 5 },
    ];
    const { old, new: updated } = buildInlineChangesForPairs(pairs, oldLines, newLines);
    expect(old).toEqual([{ startLineNumber: 3, startColumn: 7, endLineNumber: 3, endColumn: 10 }]);
    expect(updated).toEqual([
      { startLineNumber: 3, startColumn: 7, endLineNumber: 3, endColumn: 10 },
    ]);
  });
});

describe("rangesByLine", () => {
  it("splits a multi-line range into per-line spans and drops empty spans", () => {
    const lines = ["abcdef", "ghij", "klmno"];
    const spans = rangesByLine(
      [{ startLineNumber: 1, startColumn: 4, endLineNumber: 3, endColumn: 3 }],
      lines,
    );
    expect(spans).toEqual([
      [{ startColumn: 4, endColumn: 7 }],
      [{ startColumn: 1, endColumn: 5 }],
      [{ startColumn: 1, endColumn: 3 }],
    ]);
  });

  it("keeps single-line ranges on their line", () => {
    const spans = rangesByLine(
      [{ startLineNumber: 2, startColumn: 2, endLineNumber: 2, endColumn: 4 }],
      ["aa", "bbbb"],
    );
    expect(spans).toEqual([[], [{ startColumn: 2, endColumn: 4 }]]);
  });
});
