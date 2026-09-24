import { describe, expect, test } from "bun:test";

import remarkParse from "remark-parse";
import { unified } from "unified";

import {
  type MarkdownBlockCodec,
  alignBlocks,
  createSourceBaseline,
  preserveSource,
  topLevelBlockRanges,
} from "./markdown-source-preservation";

describe("alignBlocks", () => {
  test("matches identical lists entirely", () => {
    expect(alignBlocks(["a", "b", "c"], ["a", "b", "c"])).toEqual([0, 1, 2]);
  });

  test("marks a changed block as unmatched", () => {
    expect(alignBlocks(["a", "b", "c"], ["a", "B", "c"])).toEqual([0, -1, 2]);
  });

  test("handles insertions and deletions", () => {
    expect(alignBlocks(["a", "b", "c"], ["a", "x", "b", "c"])).toEqual([0, -1, 1, 2]);
    expect(alignBlocks(["a", "b", "c"], ["a", "c"])).toEqual([0, 2]);
  });

  test("aligns a reordered middle by longest common subsequence", () => {
    expect(alignBlocks(["h", "a", "b", "c", "t"], ["h", "c", "a", "b", "t"])).toEqual([
      0, -1, 1, 2, 4,
    ]);
  });

  test("keeps matches strictly increasing with duplicate blocks", () => {
    const match = alignBlocks(["x", "---", "y", "---"], ["---", "y", "---", "z"]);
    expect(match).toEqual([1, 2, 3, -1]);
  });

  test("handles empty inputs", () => {
    expect(alignBlocks([], ["a"])).toEqual([-1]);
    expect(alignBlocks(["a"], [])).toEqual([]);
  });
});

describe("topLevelBlockRanges", () => {
  const parse = (md: string) => unified().use(remarkParse).parse(md);

  test("returns the offsets of each top-level block", () => {
    const md = "# Title\n\n* one\n* two\n\npara\n";
    const ranges = topLevelBlockRanges(parse(md));
    expect(ranges?.map((r) => md.slice(r.start, r.end))).toEqual([
      "# Title",
      "* one\n* two",
      "para",
    ]);
  });

  test("returns null when a block has no position", () => {
    expect(topLevelBlockRanges({ type: "root", children: [{ type: "paragraph" }] })).toBeNull();
    expect(topLevelBlockRanges("not a tree")).toBeNull();
  });
});

/**
 * Minimal codec over plain remark: canonical form lowercases text and normalizes `*` bullets
 * to `-`, and equivalence compares canonical forms. Enough to exercise the reconciliation.
 */
function testCodec(): MarkdownBlockCodec {
  const processor = unified().use(remarkParse);
  const canonicalize = (md: string) =>
    md
      .split(/\n{2,}/)
      .map((b) => b.trim().replace(/^\* /gm, "- "))
      .filter(Boolean)
      .join("\n\n")
      .concat("\n");
  return {
    blockRanges: (md) => topLevelBlockRanges(processor.parse(md)),
    canonicalize,
    equivalent: (a, b) => canonicalize(a) === canonicalize(b),
  };
}

describe("preserveSource", () => {
  const codec = testCodec();
  const source = "* one\n* two\n\n\n\npara\n\n* three\n";

  test("returns the source when nothing changed", () => {
    const baseline = createSourceBaseline(source, codec);
    expect(preserveSource(baseline!.canonical, baseline, codec)).toBe(source);
  });

  test("keeps untouched blocks and the gaps around a block edited in place", () => {
    const baseline = createSourceBaseline(source, codec);
    const edited = "- one\n- two\n\npara edited\n\n- three\n";
    expect(preserveSource(edited, baseline, codec)).toBe(
      "* one\n* two\n\n\n\npara edited\n\n* three\n",
    );
  });

  test("uses serializer separators around inserted blocks", () => {
    const baseline = createSourceBaseline(source, codec);
    const edited = "- one\n- two\n\nnew\n\npara\n\n- three\n";
    expect(preserveSource(edited, baseline, codec)).toBe(
      "* one\n* two\n\nnew\n\npara\n\n* three\n",
    );
  });

  test("returns the canonical text when validation fails", () => {
    const baseline = createSourceBaseline(source, codec);
    const strict: MarkdownBlockCodec = { ...codec, equivalent: () => false };
    const edited = "- one\n- two\n\npara edited\n\n- three\n";
    expect(preserveSource(edited, baseline, strict)).toBe(edited);
  });

  test("without a baseline returns the canonical text", () => {
    expect(preserveSource("- a\n", null, codec)).toBe("- a\n");
  });
});
