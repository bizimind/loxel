import { describe, expect, test } from "bun:test";

import { parseDiffOutput } from "./diff";

function header(line: string, extra = "") {
  return `${line}\n${extra}index 0000000..1111111\n--- a/x\n+++ b/x\n@@ -0,0 +1 @@\n+x\n`;
}

describe("parseDiffOutput header paths", () => {
  test.each([
    { name: "plain", line: "diff --git a/src/a.ts b/src/a.ts", old: "src/a.ts", new: "src/a.ts" },
    {
      name: "spaces",
      line: "diff --git a/sp ace.txt b/sp ace.txt",
      old: "sp ace.txt",
      new: "sp ace.txt",
    },
    {
      name: "both sides quoted (non-ASCII octal escapes)",
      line: 'diff --git "a/\\303\\274n\\303\\257.txt" "b/\\303\\274n\\303\\257.txt"',
      old: "ünï.txt",
      new: "ünï.txt",
    },
    {
      name: "only the new side quoted",
      line: 'diff --git a/plain.txt "b/\\303\\2742.txt"',
      old: "plain.txt",
      new: "ü2.txt",
    },
    {
      name: "only the old side quoted",
      line: 'diff --git "a/q\\"t.txt" b/sp ace.txt',
      old: 'q"t.txt',
      new: "sp ace.txt",
    },
    {
      name: "backslash and tab escapes",
      line: 'diff --git "a/a\\\\b\\tc" "b/a\\\\b\\tc"',
      old: "a\\b\tc",
      new: "a\\b\tc",
    },
  ])("$name", ({ line, old, new: newPath }) => {
    const [file] = parseDiffOutput(header(line));
    expect(file).toMatchObject({ oldPath: old, newPath, additions: 1 });
  });
});

describe("parseDiffOutput paths", () => {
  test("reads a name containing ' b/' as the same path on both sides", () => {
    const [file] = parseDiffOutput(header("diff --git a/src b/index.ts b/src b/index.ts"));
    expect(file).toMatchObject({ oldPath: "src b/index.ts", newPath: "src b/index.ts" });
  });

  test("takes a rename's paths from its rename lines", () => {
    const diff = [
      "diff --git a/old b/x.ts b/new b/y.ts",
      "similarity index 100%",
      "rename from old b/x.ts",
      'rename to "new b/\\303\\274.ts"',
      "",
    ].join("\n");
    const [file] = parseDiffOutput(diff);
    expect(file).toMatchObject({ status: "renamed", oldPath: "old b/x.ts", newPath: "new b/ü.ts" });
  });
});

describe("parseDiffOutput hunk lines", () => {
  const diff = (body: string[]) =>
    [
      "diff --git a/x.c b/x.c",
      "index 0000000..1111111 100644",
      "--- a/x.c",
      "+++ b/x.c",
      ...body,
      "",
    ].join("\n");

  test("keeps an added line starting with '++' and a deleted line starting with '--'", () => {
    const [file] = parseDiffOutput(
      diff(["@@ -1,3 +1,3 @@", " int i = 0;", "---count;", "+++i;", " return i;"]),
    );
    expect(file?.additions).toBe(1);
    expect(file?.deletions).toBe(1);
    expect(file?.hunks[0]?.lines).toEqual([
      { type: "normal", content: "int i = 0;", oldLineNumber: 1, newLineNumber: 1 },
      { type: "delete", content: "--count;", oldLineNumber: 2 },
      { type: "add", content: "++i;", newLineNumber: 2 },
      { type: "normal", content: "return i;", oldLineNumber: 3, newLineNumber: 3 },
    ]);
  });

  test("keeps content lines that look like file headers", () => {
    const [file] = parseDiffOutput(diff(["@@ -1 +1 @@", "--- a/x.c", "+++ b/x.c"]));
    expect(file?.hunks[0]?.lines.map((line) => [line.type, line.content])).toEqual([
      ["delete", "-- a/x.c"],
      ["add", "++ b/x.c"],
    ]);
  });

  test("numbers lines across a missing newline marker and a second hunk", () => {
    const [file] = parseDiffOutput(
      diff([
        "@@ -1 +1,2 @@",
        "-a",
        "\\ No newline at end of file",
        "+a",
        "+b",
        "@@ -10,2 +11 @@",
        " c",
        "-d",
      ]),
    );
    expect(file?.hunks.map((hunk) => hunk.lines)).toEqual([
      [
        { type: "delete", content: "a", oldLineNumber: 1 },
        { type: "normal", content: "\\ No newline at end of file" },
        { type: "add", content: "a", newLineNumber: 1 },
        { type: "add", content: "b", newLineNumber: 2 },
      ],
      [
        { type: "normal", content: "c", oldLineNumber: 10, newLineNumber: 11 },
        { type: "delete", content: "d", oldLineNumber: 11 },
      ],
    ]);
    expect(file).toMatchObject({ additions: 2, deletions: 2 });
  });

  test("reads an empty line inside a hunk as an empty context line", () => {
    const [file] = parseDiffOutput(diff(["@@ -1,4 +1,5 @@", " a", "", "-b", "+B", " c", "+d"]));
    expect(file?.hunks[0]?.lines.map((line) => [line.type, line.content])).toEqual([
      ["normal", "a"],
      ["normal", ""],
      ["delete", "b"],
      ["add", "B"],
      ["normal", "c"],
      ["add", "d"],
    ]);
    expect(file).toMatchObject({ additions: 2, deletions: 1 });
  });

  test("starts the next hunk at its header even when the previous one is short", () => {
    const [file] = parseDiffOutput(
      diff(["@@ -1,3 +1,3 @@", "-x", "+y", "@@ -10 +10 @@", "-p", "+q"]),
    );
    expect(file?.hunks.map((hunk) => hunk.lines.length)).toEqual([2, 2]);
  });
});
