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
