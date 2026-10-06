import { describe, expect, test } from "bun:test";

import type { FileDiff } from "@/api/diff-model";
import { fileDiffPath } from "@/api/diff-model";

import { orderDiffFiles } from "./diff-file-tree";

const file = (path: string): FileDiff => ({
  oldPath: path,
  newPath: path,
  status: "modified",
  hunks: [],
  isBinary: false,
  additions: 1,
  deletions: 0,
});

describe("orderDiffFiles", () => {
  test("lists files in Changes tree order: folders first, then by name, depth-first", () => {
    // Git order: tracked files by path, then untracked ones appended.
    const files = ["README.md", "src/b.ts", "src/z/y.ts", "a.ts", "src/a/new.ts"].map(file);
    expect(orderDiffFiles(files).map(fileDiffPath)).toEqual([
      "src/a/new.ts",
      "src/z/y.ts",
      "src/b.ts",
      "a.ts",
      "README.md",
    ]);
  });

  test("keeps every file, including deleted ones and files under compacted folders", () => {
    const deleted: FileDiff = { ...file("lib/gone.ts"), newPath: "", status: "deleted" };
    const files = [file("pkg/core/src/index.ts"), deleted];
    expect(orderDiffFiles(files)).toEqual([deleted, files[0]!]);
  });
});
