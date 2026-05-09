import { describe, expect, test } from "bun:test";

import { threeWayMerge } from "./three-way-merge";

describe("threeWayMerge", () => {
  test("both sides identical → returns ours", () => {
    const result = threeWayMerge("a\nb\nc", "a\nb\nc", "a\nb\nc");
    expect(result).toEqual({ ok: true, merged: "a\nb\nc" });
  });

  test("ours unchanged → returns theirs", () => {
    const result = threeWayMerge("a\nb\nc", "a\nb\nc", "a\nX\nc");
    expect(result).toEqual({ ok: true, merged: "a\nX\nc" });
  });

  test("theirs unchanged → returns ours", () => {
    const result = threeWayMerge("a\nb\nc", "a\nX\nc", "a\nb\nc");
    expect(result).toEqual({ ok: true, merged: "a\nX\nc" });
  });

  test("ours and theirs identical changes → returns either", () => {
    const result = threeWayMerge("a\nb\nc", "a\nX\nc", "a\nX\nc");
    expect(result).toEqual({ ok: true, merged: "a\nX\nc" });
  });

  test("non-overlapping: ours edits top, theirs edits bottom", () => {
    const base = "a\nb\nc\nd\ne";
    const ours = "X\nb\nc\nd\ne";
    const theirs = "a\nb\nc\nd\nZ";
    const result = threeWayMerge(base, ours, theirs);
    expect(result).toEqual({ ok: true, merged: "X\nb\nc\nd\nZ" });
  });

  test("non-overlapping: ours edits middle, theirs appends", () => {
    const base = "a\nb\nc";
    const ours = "a\nX\nc";
    const theirs = "a\nb\nc\nd\ne";
    const result = threeWayMerge(base, ours, theirs);
    expect(result).toEqual({ ok: true, merged: "a\nX\nc\nd\ne" });
  });

  test("non-overlapping: theirs inserts at top, ours edits bottom", () => {
    const base = "a\nb\nc";
    const ours = "a\nb\nZ";
    const theirs = "X\na\nb\nc";
    const result = threeWayMerge(base, ours, theirs);
    expect(result).toEqual({ ok: true, merged: "X\na\nb\nZ" });
  });

  test("overlapping: both modify same line → conflict", () => {
    const base = "a\nb\nc";
    const ours = "a\nX\nc";
    const theirs = "a\nY\nc";
    const result = threeWayMerge(base, ours, theirs);
    expect(result).toEqual({ ok: false, reason: "conflict" });
  });

  test("overlapping: ours deletes line, theirs modifies it → conflict", () => {
    const base = "a\nb\nc";
    const ours = "a\nc";
    const theirs = "a\nX\nc";
    const result = threeWayMerge(base, ours, theirs);
    expect(result).toEqual({ ok: false, reason: "conflict" });
  });

  test("agent inserts block in middle, user edits top → clean merge", () => {
    const base = "title\n\nbody line 1\nbody line 2\n\nfooter";
    const ours = "TITLE\n\nbody line 1\nbody line 2\n\nfooter";
    const theirs = "title\n\nbody line 1\nbody line 2\n\nnew section\nmore content\n\nfooter";
    const result = threeWayMerge(base, ours, theirs);
    expect(result).toEqual({
      ok: true,
      merged: "TITLE\n\nbody line 1\nbody line 2\n\nnew section\nmore content\n\nfooter",
    });
  });

  test("empty base → not a conflict, just returns theirs if ours unchanged", () => {
    // Empty base means both sides diverged from nothing — treat as ours unchanged
    const result = threeWayMerge("", "", "new content");
    expect(result).toEqual({ ok: true, merged: "new content" });
  });

  test("single-line files with different changes → conflict", () => {
    const result = threeWayMerge("hello", "hello world", "hello there");
    expect(result).toEqual({ ok: false, reason: "conflict" });
  });

  test("both sides add different lines at end → conflict", () => {
    // Both modify the last region (beyond base), which overlaps
    const base = "a\nb";
    const ours = "a\nb\nX";
    const theirs = "a\nb\nY";
    const result = threeWayMerge(base, ours, theirs);
    expect(result).toEqual({ ok: false, reason: "conflict" });
  });

  test("both sides add identical lines at end → merge", () => {
    const base = "a\nb";
    const ours = "a\nb\nX";
    const theirs = "a\nb\nX";
    expect(threeWayMerge(base, ours, theirs)).toEqual({ ok: true, merged: "a\nb\nX" });
  });

  test("ours deletes lines at top, theirs edits bottom → clean merge", () => {
    const base = "a\nb\nc\nd";
    const ours = "c\nd";
    const theirs = "a\nb\nc\nZ";
    const result = threeWayMerge(base, ours, theirs);
    expect(result).toEqual({ ok: true, merged: "c\nZ" });
  });

  test("multiple non-overlapping hunks from both sides", () => {
    const base = "1\n2\n3\n4\n5\n6\n7\n8\n9";
    const ours = "A\n2\n3\n4\n5\n6\n7\n8\n9"; // changed line 1
    const theirs = "1\n2\n3\n4\nE\n6\n7\n8\nI"; // changed lines 5 and 9
    const result = threeWayMerge(base, ours, theirs);
    expect(result).toEqual({ ok: true, merged: "A\n2\n3\n4\nE\n6\n7\n8\nI" });
  });
});
