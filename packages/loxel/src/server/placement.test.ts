import { describe, expect, mock, test } from "bun:test";

import type { CommentThread, DiffFileContext } from "../api/review-model";
import { createContentAnchor } from "../lib/content-anchor";

function mockGitCommands(
  overrides: Partial<{
    getFileContent: (cwd: string, path: string, ref?: string) => Promise<string[]>;
    getWorkingTreeFileContent: (cwd: string, worktree: string, path: string) => Promise<string[]>;
  }>,
) {
  mock.module("./git-commands", () => ({
    getFileContent: async (_cwd: string, _path: string, _ref?: string): Promise<string[]> => [],
    getGitRoot: async (cwd: string): Promise<string> => cwd,
    getWorkingTreeFileContent: async (
      _cwd: string,
      _worktree: string,
      _path: string,
    ): Promise<string[]> => [],
    isBareRepo: async (): Promise<boolean> => false,
    ...overrides,
  }));
}

// Mock git-commands before importing placement
mockGitCommands({});

const { placeThreads } = await import("./placement");

function makeThread(overrides: Partial<CommentThread> & { filePath: string }): CommentThread {
  return {
    id: crypto.randomUUID(),
    reviewId: "review-1",
    createdSide: "new",
    contentAnchor: createContentAnchor(["line 10", "line 11", "line 12"], 1, 3),
    startLine: 10,
    endLine: 12,
    status: "open",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    comments: [],
    ...overrides,
  };
}

function makeFileContext(overrides?: Partial<DiffFileContext>): DiffFileContext {
  return { oldPath: "foo.ts", newPath: "foo.ts", oldRef: "abc123", newRef: "def456", ...overrides };
}

describe("placeThreads", () => {
  test("returns empty array for no threads", async () => {
    const result = await placeThreads("/tmp", [], [makeFileContext()]);
    expect(result).toEqual([]);
  });

  test("marks thread as lost when file not in diff", async () => {
    const thread = makeThread({ filePath: "not-in-diff.ts" });
    const result = await placeThreads("/tmp", [thread], [makeFileContext()]);

    expect(result).toHaveLength(1);
    expect(result[0]!.anchorStatus).toBe("lost");
    expect(result[0]!.displaySide).toBe("new");
  });

  test("places thread as exact when content matches at stored position", async () => {
    const lines = Array.from({ length: 15 }, (_, i) => `line ${i + 1}`);
    const anchor = createContentAnchor(lines, 10, 12);

    const thread = makeThread({
      filePath: "foo.ts",
      createdSide: "new",
      contentAnchor: anchor,
      startLine: 10,
      endLine: 12,
    });

    mockGitCommands({
      getFileContent: async () => lines,
      getWorkingTreeFileContent: async () => [],
    });

    // Re-import to pick up mock
    const { placeThreads: pt } = await import("./placement");
    const result = await pt("/tmp", [thread], [makeFileContext()]);

    expect(result).toHaveLength(1);
    expect(result[0]!.anchorStatus).toBe("exact");
    expect(result[0]!.displaySide).toBe("new");
    expect(result[0]!.displayStartLine).toBe(10);
    expect(result[0]!.displayEndLine).toBe(12);
  });

  test("places thread as outdated when context matches but content changed", async () => {
    const originalLines = Array.from({ length: 15 }, (_, i) => `line ${i + 1}`);
    const anchor = createContentAnchor(originalLines, 10, 12);

    // Modify lines 10-12 but keep surrounding context intact
    const modifiedLines = [...originalLines];
    modifiedLines[9] = "modified 10";
    modifiedLines[10] = "modified 11";
    modifiedLines[11] = "modified 12";

    const thread = makeThread({
      filePath: "foo.ts",
      createdSide: "new",
      contentAnchor: anchor,
      startLine: 10,
      endLine: 12,
    });

    mockGitCommands({
      getFileContent: async () => modifiedLines,
      getWorkingTreeFileContent: async () => [],
    });

    const { placeThreads: pt } = await import("./placement");
    const result = await pt("/tmp", [thread], [makeFileContext()]);

    expect(result).toHaveLength(1);
    expect(result[0]!.anchorStatus).toBe("outdated");
    expect(result[0]!.displayStartLine).toBe(10);
    expect(result[0]!.displayEndLine).toBe(12);
    expect(result[0]!.originalContent).toEqual(["line 10", "line 11", "line 12"]);
    expect(result[0]!.currentContent).toEqual(["modified 10", "modified 11", "modified 12"]);
  });

  test("handles renamed files by matching both paths", async () => {
    const originalLines = Array.from({ length: 15 }, (_, i) => `line ${i + 1}`);
    const anchor = createContentAnchor(originalLines, 10, 12);

    const thread = makeThread({
      filePath: "old-name.ts",
      createdSide: "old",
      contentAnchor: anchor,
      startLine: 10,
      endLine: 12,
    });

    mockGitCommands({
      getFileContent: async () => originalLines,
      getWorkingTreeFileContent: async () => [],
    });

    const file = makeFileContext({ oldPath: "old-name.ts", newPath: "new-name.ts" });

    const { placeThreads: pt } = await import("./placement");
    const result = await pt("/tmp", [thread], [file]);

    expect(result).toHaveLength(1);
    expect(result[0]!.anchorStatus).toBe("exact");
    expect(result[0]!.displaySide).toBe("old");
    expect(result[0]!.displayStartLine).toBe(10);
  });
});
