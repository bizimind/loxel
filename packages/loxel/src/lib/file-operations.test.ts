import { beforeEach, describe, expect, mock, test } from "bun:test";

import { localRef } from "@/api/local-server";

const actualClient = await import("@/api/client");
mock.module("@/api/client", () => ({
  ...actualClient,
  renameProjectFile: async (_wt: string, options: { path: string; newName: string }) => ({
    newPath: `${options.path.slice(0, options.path.lastIndexOf("/"))}/${options.newName}`,
  }),
  moveProjectFile: async (_wt: string, options: { srcPath: string; destDir: string }) => ({
    newPath: `${options.destDir}/${options.srcPath.split("/").pop()}`,
  }),
  deleteProjectFile: async () => {},
}));
mock.module("@/queries/query-helpers", () => ({ invalidateDirQueries: () => {} }));

const { getWorktreeUI } = await import("@/store/worktree-ui");
const { useWorktreeStore } = await import("@/store/worktrees");
const { deleteFile, moveFile, renameFile } = await import("./file-operations");

// A language-server edit of worktree /repo finishing after the user switched to /other.
beforeEach(() => {
  useWorktreeStore.setState({ activeWorktreePath: "/other" });
  getWorktreeUI(localRef("/other")).getState().setSelectedProjectFile("/repo/a.py");
});

function selected(wt: string): string | null {
  return getWorktreeUI(localRef(wt)).getState().selectedProjectFile;
}

describe("file operations update the UI state of the worktree they were given", () => {
  test("rename", async () => {
    getWorktreeUI(localRef("/repo")).getState().setSelectedProjectFile("/repo/a.py");
    await renameFile({
      wt: localRef("/repo"),
      path: "/repo/a.py",
      newName: "b.py",
      isDetached: false,
    });
    expect(selected("/repo")).toBe("/repo/b.py");
    expect(selected("/other")).toBe("/repo/a.py");
  });

  test("move", async () => {
    getWorktreeUI(localRef("/repo")).getState().setSelectedProjectFile("/repo/a.py");
    await moveFile({ wt: localRef("/repo"), srcPath: "/repo/a.py", destDir: "/repo/pkg" });
    expect(selected("/repo")).toBe("/repo/pkg/a.py");
    expect(selected("/other")).toBe("/repo/a.py");
  });

  test("delete", async () => {
    getWorktreeUI(localRef("/repo")).getState().setSelectedProjectFile("/repo/a.py");
    await deleteFile({ wt: localRef("/repo"), path: "/repo/a.py", isDetached: false });
    expect(selected("/repo")).toBeNull();
    expect(selected("/other")).toBe("/repo/a.py");
  });
});
