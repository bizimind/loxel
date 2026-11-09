import { describe, expect, test } from "bun:test";

import type { DiffLine } from "@/api/diff-model";

import { parseUnifiedDiff } from "./parse-unified-diff";

/** Lines of a hunk as `<marker><content>` with their line numbers, for compact assertions. */
function rows(lines: DiffLine[]): string[] {
  const marker = { add: "+", delete: "-", normal: " " } as const;
  return lines.map(
    (line) =>
      `${line.oldLineNumber ?? "."} ${line.newLineNumber ?? "."} ${marker[line.type]}${line.content}`,
  );
}

describe("parseUnifiedDiff", () => {
  test("parses a git diff with several files", () => {
    const diff = parseUnifiedDiff(
      [
        "diff --git a/src/a.ts b/src/a.ts",
        "index 1111111..2222222 100644",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -10,3 +10,3 @@ function main() {",
        " keep",
        "-old",
        "+new",
        " tail",
        "diff --git a/added.md b/added.md",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/added.md",
        "@@ -0,0 +1,2 @@",
        "+one",
        "+two",
        "",
      ].join("\n"),
    );
    expect(diff?.baseRef).toBeNull();
    expect(diff?.files).toHaveLength(2);
    const [modified, added] = diff!.files;
    expect(modified).toMatchObject({
      oldPath: "src/a.ts",
      newPath: "src/a.ts",
      status: "modified",
      additions: 1,
      deletions: 1,
    });
    expect(modified!.hunks[0]).toMatchObject({
      oldStart: 10,
      oldLines: 3,
      newStart: 10,
      newLines: 3,
      header: "@@ -10,3 +10,3 @@ function main() {",
    });
    expect(rows(modified!.hunks[0]!.lines)).toEqual([
      "10 10  keep",
      "11 . -old",
      ". 11 +new",
      "12 12  tail",
    ]);
    expect(added).toMatchObject({ oldPath: "added.md", newPath: "added.md", status: "added" });
    expect(rows(added!.hunks[0]!.lines)).toEqual([". 1 +one", ". 2 +two"]);
  });

  test("parses a plain unified diff with timestamps and no git headers", () => {
    const diff = parseUnifiedDiff(
      [
        "--- old/config.yml\t2024-01-01 10:00:00",
        "+++ new/config.yml\t2024-01-02 10:00:00",
        "@@ -1 +1 @@",
        "-port: 80",
        "+port: 8080",
      ].join("\n"),
    );
    expect(diff?.files[0]).toMatchObject({
      oldPath: "old/config.yml",
      newPath: "new/config.yml",
      status: "renamed",
    });
    expect(rows(diff!.files[0]!.hunks[0]!.lines)).toEqual(["1 . -port: 80", ". 1 +port: 8080"]);
  });

  test("renders bare +/- lines as one unnumbered hunk, keeping every line", () => {
    const diff = parseUnifiedDiff("// config\n-const a = 1;\n+const a = 2;\n same\n");
    expect(diff?.files).toHaveLength(1);
    const [file] = diff!.files;
    expect(file).toMatchObject({ oldPath: "", newPath: "", additions: 1, deletions: 1 });
    expect(file!.hunks).toHaveLength(1);
    expect(file!.hunks[0]!.header).toBe("");
    // The leading comment is not a hunk line: it is outside any hunk and dropped.
    expect(rows(file!.hunks[0]!.lines)).toEqual([
      ". . -const a = 1;",
      ". . +const a = 2;",
      ". .  same",
    ]);
  });

  test("keeps unrecognized lines inside a loose snippet as context", () => {
    const diff = parseUnifiedDiff("-a\nplain text\n+b\n");
    expect(rows(diff!.files[0]!.hunks[0]!.lines)).toEqual([". . -a", ". .  plain text", ". . +b"]);
  });

  test("parses a hunk without file headers", () => {
    const diff = parseUnifiedDiff("@@ -5,2 +5,2 @@\n-x\n+y\n z\n");
    expect(diff?.files[0]).toMatchObject({ oldPath: "", newPath: "" });
    expect(rows(diff!.files[0]!.hunks[0]!.lines)).toEqual(["5 . -x", ". 5 +y", "6 6  z"]);
  });

  test("keeps lines past wrong hunk counts and recounts the hunk", () => {
    const diff = parseUnifiedDiff("--- a/f\n+++ b/f\n@@ -1,1 +1,1 @@\n-a\n+b\n+c\n d\n");
    const hunk = diff!.files[0]!.hunks[0]!;
    expect(rows(hunk.lines)).toEqual(["1 . -a", ". 1 +b", ". 2 +c", "2 3  d"]);
    expect(hunk).toMatchObject({ oldLines: 2, newLines: 3 });
  });

  test("treats a hunk header without numbers as an unnumbered hunk", () => {
    const diff = parseUnifiedDiff("--- a/f\n+++ b/f\n@@ ... @@\n-a\n+b\n");
    const hunk = diff!.files[0]!.hunks[0]!;
    expect(hunk.header).toBe("@@ ... @@");
    expect(rows(hunk.lines)).toEqual([". . -a", ". . +b"]);
  });

  test("reads --- and +++ inside a hunk as content while the counts expect lines", () => {
    const diff = parseUnifiedDiff("--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n--- x\n+++ y\n same\n");
    expect(diff?.files).toHaveLength(1);
    expect(rows(diff!.files[0]!.hunks[0]!.lines)).toEqual(["1 . --- x", ". 1 +++ y", "2 2  same"]);
  });

  test("blank lines are context while the counts expect lines, and dropped after", () => {
    const diff = parseUnifiedDiff("@@ -1,3 +1,3 @@\n a\n\n-b\n+c\n\n\n");
    expect(rows(diff!.files[0]!.hunks[0]!.lines)).toEqual(["1 1  a", "2 2  ", "3 . -b", ". 3 +c"]);
  });

  test("starts a new file after a hunk whose counts were too high", () => {
    const diff = parseUnifiedDiff(
      "diff --git a/x b/x\n@@ -1,9 +1,9 @@\n-a\n+b\ndiff --git a/y b/y\n@@ -1 +1 @@\n-c\n+d\n",
    );
    expect(diff?.files.map((file) => file.newPath)).toEqual(["x", "y"]);
  });

  test("keeps rename and binary metadata for files without hunks", () => {
    const diff = parseUnifiedDiff(
      [
        "diff --git a/old name.ts b/new name.ts",
        "similarity index 100%",
        "rename from old name.ts",
        "rename to new name.ts",
        "diff --git a/logo.png b/logo.png",
        "index 1..2 100644",
        "Binary files a/logo.png and b/logo.png differ",
      ].join("\n"),
    );
    expect(diff?.files).toEqual([
      expect.objectContaining({
        oldPath: "old name.ts",
        newPath: "new name.ts",
        status: "renamed",
        hunks: [],
      }),
      expect.objectContaining({ newPath: "logo.png", isBinary: true }),
    ]);
  });

  test("a rename with content changes stays one file", () => {
    const diff = parseUnifiedDiff(
      "diff --git a/a b/b\nsimilarity index 90%\nrename from a\nrename to b\n--- a/a\n+++ b/b\n@@ -1 +1 @@\n-x\n+y\n",
    );
    expect(diff?.files).toHaveLength(1);
    expect(diff?.files[0]).toMatchObject({ oldPath: "a", newPath: "b", status: "renamed" });
  });

  test("marks deleted files from /dev/null", () => {
    const diff = parseUnifiedDiff("--- a/gone.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n");
    expect(diff?.files[0]).toMatchObject({
      oldPath: "gone.txt",
      newPath: "gone.txt",
      status: "deleted",
    });
  });

  test("ignores a format-patch preamble", () => {
    const diff = parseUnifiedDiff(
      [
        "From 1234 Mon Sep 17 00:00:00 2001",
        "Subject: [PATCH] Fix it",
        "",
        "---",
        " f.txt | 2 +-",
        " 1 file changed",
        "",
        "diff --git a/f.txt b/f.txt",
        "--- a/f.txt",
        "+++ b/f.txt",
        "@@ -1 +1 @@",
        "-a",
        "+b",
        "-- ",
        "2.40.0",
      ].join("\n"),
    );
    expect(diff?.files).toHaveLength(1);
    expect(rows(diff!.files[0]!.hunks[0]!.lines)).toEqual(["1 . -a", ". 1 +b"]);
  });

  test("keeps the no-newline marker without line numbers", () => {
    const diff = parseUnifiedDiff("@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n");
    const hunk = diff!.files[0]!.hunks[0]!;
    expect(rows(hunk.lines)).toEqual(["1 . -a", ". .  \\ No newline at end of file", ". 1 +b"]);
    expect(hunk).toMatchObject({ oldLines: 1, newLines: 1 });
  });

  test("handles CRLF line endings", () => {
    const diff = parseUnifiedDiff("--- a/f\r\n+++ b/f\r\n@@ -1 +1 @@\r\n-a\r\n+b\r\n");
    expect(rows(diff!.files[0]!.hunks[0]!.lines)).toEqual(["1 . -a", ". 1 +b"]);
  });

  test("keeps a context line that lost its leading space while the counts expect lines", () => {
    const diff = parseUnifiedDiff(
      "@@ -1,4 +1,4 @@\n function f() {\nconst y = 2;\n-  old();\n+  new();\n }\n",
    );
    const [file] = diff!.files;
    expect(file!.hunks).toHaveLength(1);
    expect(rows(file!.hunks[0]!.lines)).toEqual([
      "1 1  function f() {",
      "2 2  const y = 2;",
      "3 . -  old();",
      ". 3 +  new();",
      "4 4  }",
    ]);
  });

  test("a ---/+++ pair followed by @@ starts a new file even when the counts were too high", () => {
    const diff = parseUnifiedDiff(
      "--- a/x\n+++ b/x\n@@ -1,5 +1,5 @@\n-a\n+b\n c\n--- a/y\n+++ b/y\n@@ -1 +1 @@\n-d\n+e\n",
    );
    expect(diff?.files.map((file) => file.newPath)).toEqual(["x", "y"]);
    expect(rows(diff!.files[0]!.hunks[0]!.lines)).toEqual(["1 . -a", ". 1 +b", "2 2  c"]);
  });

  test("decodes C-quoted paths", () => {
    const diff = parseUnifiedDiff(
      [
        'diff --git "a/\\303\\251t\\303\\251.txt" "b/\\303\\251t\\303\\251.txt"',
        '--- "a/\\303\\251t\\303\\251.txt"',
        '+++ "b/\\303\\251t\\303\\251.txt"',
        "@@ -1 +1 @@",
        "-a",
        "+b",
      ].join("\n"),
    );
    expect(diff?.files).toHaveLength(1);
    expect(diff?.files[0]).toMatchObject({ oldPath: "été.txt", newPath: "été.txt" });
  });

  test("strips git's mnemonic side prefixes", () => {
    const diff = parseUnifiedDiff("--- i/src/x.ts\n+++ w/src/x.ts\n@@ -1 +1 @@\n-a\n+b\n");
    expect(diff?.files[0]).toMatchObject({
      oldPath: "src/x.ts",
      newPath: "src/x.ts",
      status: "modified",
    });
  });

  test("returns null for text with no diff in it", () => {
    expect(parseUnifiedDiff("--- before\n+++ after\n")).toBeNull();
    expect(parseUnifiedDiff("")).toBeNull();
    expect(parseUnifiedDiff("just some notes\nabout a change\n")).toBeNull();
    expect(parseUnifiedDiff(" only\n context\n")).toBeNull();
  });
});
