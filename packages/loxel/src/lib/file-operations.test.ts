import { beforeEach, describe, expect, mock, test } from "bun:test";

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

const { setActiveWorktreeKey } = await import("@/store/worktree-store");
const { getWorktreeUI } = await import("@/store/worktree-ui");
const { deleteFile, moveFile, renameFile } = await import("./file-operations");

// A language-server edit of worktree /repo finishing after the user switched to /other.
beforeEach(() => {
  setActiveWorktreeKey("/other");
  getWorktreeUI("/other").getState().setSelectedProjectFile("/repo/a.py");
});

function selected(wt: string): string | null {
  return getWorktreeUI(wt).getState().selectedProjectFile;
}

describe("file operations update the UI state of the worktree they were given", () => {
  test("rename", async () => {
    getWorktreeUI("/repo").getState().setSelectedProjectFile("/repo/a.py");
    await renameFile({ wt: "/repo", path: "/repo/a.py", newName: "b.py", isDetached: false });
    expect(selected("/repo")).toBe("/repo/b.py");
    expect(selected("/other")).toBe("/repo/a.py");
  });

  test("move", async () => {
    getWorktreeUI("/repo").getState().setSelectedProjectFile("/repo/a.py");
    await moveFile({ wt: "/repo", srcPath: "/repo/a.py", destDir: "/repo/pkg" });
    expect(selected("/repo")).toBe("/repo/pkg/a.py");
    expect(selected("/other")).toBe("/repo/a.py");
  });

  test("delete", async () => {
    getWorktreeUI("/repo").getState().setSelectedProjectFile("/repo/a.py");
    await deleteFile({ wt: "/repo", path: "/repo/a.py", isDetached: false });
    expect(selected("/repo")).toBeNull();
    expect(selected("/other")).toBe("/repo/a.py");
  });
});
