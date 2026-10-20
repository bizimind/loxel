import { describe, expect, it } from "bun:test";

import { buildChangeRegions } from "./change-regions";
import { computeFileDiff, splitLines } from "./compute-file-diff";

const numbered = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`);

function replaceAt(lines: string[], lineNumber: number, ...replacement: string[]): string[] {
  return [...lines.slice(0, lineNumber - 1), ...replacement, ...lines.slice(lineNumber)];
}

describe("splitLines", () => {
  it("splits on every line ending a Monaco model recognizes", () => {
    expect(splitLines("a\nb\r\nc\rd")).toEqual(["a", "b", "c", "d"]);
  });

  it("keeps a trailing empty line, as the model does", () => {
    expect(splitLines("a\n")).toEqual(["a", ""]);
    expect(splitLines("")).toEqual([""]);
  });
});

describe("computeFileDiff", () => {
  it("returns no hunks for identical content", () => {
    const lines = numbered(10);
    expect(computeFileDiff(lines, [...lines])).toEqual({ hunks: [], additions: 0, deletions: 0 });
  });

  it("surrounds a modified line with three lines of context, like git", () => {
    const oldLines = numbered(20);
    const newLines = replaceAt(oldLines, 10, "changed");
    const { hunks, additions, deletions } = computeFileDiff(oldLines, newLines);

    expect(additions).toBe(1);
    expect(deletions).toBe(1);
    expect(hunks).toHaveLength(1);
    const hunk = hunks[0]!;
    expect(hunk.header).toBe("@@ -7,7 +7,7 @@");
    expect(hunk.lines.map((l) => l.type)).toEqual([
      "normal",
      "normal",
      "normal",
      "delete",
      "add",
      "normal",
      "normal",
      "normal",
    ]);
    expect(hunk.lines[3]).toEqual({ type: "delete", content: "line 10", oldLineNumber: 10 });
    expect(hunk.lines[4]).toEqual({ type: "add", content: "changed", newLineNumber: 10 });
    expect(hunk.lines[5]).toEqual({
      type: "normal",
      content: "line 11",
      oldLineNumber: 11,
      newLineNumber: 11,
    });
  });

  it("numbers lines after an insertion by their own side", () => {
    const oldLines = numbered(10);
    const newLines = [...oldLines.slice(0, 5), "new a", "new b", ...oldLines.slice(5)];
    const [hunk] = computeFileDiff(oldLines, newLines).hunks;

    expect(hunk?.header).toBe("@@ -3,6 +3,8 @@");
    expect(hunk?.lines.at(-1)).toEqual({
      type: "normal",
      content: "line 8",
      oldLineNumber: 8,
      newLineNumber: 10,
    });
  });

  it("clips context at the start and end of the file", () => {
    const oldLines = numbered(3);
    const newLines = replaceAt(oldLines, 1, "first");
    const [hunk] = computeFileDiff(oldLines, newLines).hunks;

    expect(hunk?.header).toBe("@@ -1,3 +1,3 @@");
    expect(hunk?.lines[0]?.type).toBe("delete");
  });

  it("merges changes whose context touches into one hunk and splits distant ones", () => {
    const oldLines = numbered(40);
    const close = replaceAt(replaceAt(oldLines, 10, "a"), 17, "b");
    expect(computeFileDiff(oldLines, close).hunks).toHaveLength(1);

    const distant = replaceAt(replaceAt(oldLines, 10, "a"), 18, "b");
    const hunks = computeFileDiff(oldLines, distant).hunks;
    expect(hunks.map((h) => h.header)).toEqual(["@@ -7,7 +7,7 @@", "@@ -15,7 +15,7 @@"]);
  });

  it("starts an empty side at the line before the change, as git does", () => {
    const { hunks, additions } = computeFileDiff(["only"], ["only", "a", "b"]);
    expect(additions).toBe(2);
    expect(hunks[0]?.header).toBe("@@ -1,1 +1,3 @@");

    // A one-line file that becomes two lines without sharing any: old side has lines, new too.
    const replaced = computeFileDiff(["x"], ["y", "z"]);
    expect(replaced.hunks[0]?.header).toBe("@@ -1,1 +1,2 @@");
  });

  it("produces hunks the change-region builder reads like a server diff", () => {
    const oldLines = numbered(20);
    const newLines = [...replaceAt(oldLines, 5, "five"), "appended"];
    const { pairs } = buildChangeRegions(computeFileDiff(oldLines, newLines).hunks);

    expect(pairs).toEqual([
      { oldStart: 5, oldEnd: 5, newStart: 5, newEnd: 5, type: "modify" },
      { oldStart: 21, oldEnd: 21, newStart: 21, newEnd: 21, type: "add" },
    ]);
  });
});
