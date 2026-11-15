import { beforeEach, describe, expect, test } from "bun:test";

import { renderHook } from "@testing-library/react";

import type { FileDiff } from "@/api/diff-model";
import { getCurrentWorktreeUI } from "@/store/worktree-ui";
import { useWorktreeStore } from "@/store/worktrees";

import { useDiffFileSelection } from "./useDiffFileSelection";

function file(path: string): FileDiff {
  return {
    oldPath: path,
    newPath: path,
    status: "modified",
    hunks: [],
    isBinary: false,
    additions: 1,
    deletions: 0,
  };
}

const ui = () => getCurrentWorktreeUI().getState();

describe("useDiffFileSelection", () => {
  beforeEach(() => {
    useWorktreeStore.setState({ activeWorktreePath: "/repo" });
    ui().setSelectedDiffFile(null);
  });

  test("selects the first file when the selection leaves the diff", () => {
    ui().setSelectedDiffFile("b.ts");
    const { rerender } = renderHook(({ files }) => useDiffFileSelection(files), {
      initialProps: { files: [file("a.ts"), file("b.ts")] },
    });
    expect(ui().selectedDiffFile).toBe("b.ts");

    rerender({ files: [file("a.ts")] });
    expect(ui().selectedDiffFile).toBe("a.ts");
  });

  test("keeps the edited file selected after it leaves the diff", () => {
    ui().setSelectedDiffFile("b.ts");
    ui().setEditedDiffFile("b.ts");
    const { rerender } = renderHook(({ files }) => useDiffFileSelection(files), {
      initialProps: { files: [file("a.ts"), file("b.ts")] },
    });

    rerender({ files: [file("a.ts")] });
    expect(ui().selectedDiffFile).toBe("b.ts");
    rerender({ files: [] });
    expect(ui().selectedDiffFile).toBe("b.ts");
  });

  test("selecting another file releases the edited file", () => {
    ui().setSelectedDiffFile("b.ts");
    ui().setEditedDiffFile("b.ts");
    ui().setSelectedDiffFile("b.ts");
    expect(ui().editedDiffFile).toBe("b.ts");

    ui().setSelectedDiffFile("a.ts");
    expect(ui().editedDiffFile).toBeNull();
  });
});
