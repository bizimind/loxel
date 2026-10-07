import { beforeEach, describe, expect, jest, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

import { getCurrentRepositoryStore } from "@/store/worktree-repository";
import { setActiveWorktreeKey } from "@/store/worktree-store";
import { getCurrentWorktreeUI } from "@/store/worktree-ui";
import { useWorktreeStore } from "@/store/worktrees";

const revertToHead = jest.fn(async (_args: { worktree: string; files: string[] }) => {});
const openedFiles: string[] = [];
const missingPaths = new Set<string>();

const originalClient = await import("@/api/client");
mock.module("@/api/client", () => ({
  ...originalClient,
  getPathInfo: async (path: string) => {
    if (missingPaths.has(path)) throw new Error("Path not found");
    return { path, isDir: false };
  },
}));

mock.module("@/components/panels/BranchCommitDropdown", () => ({
  BranchCommitDropdown: () => null,
}));

mock.module("@/components/panels/DraggablePanelHeader", () => ({
  DraggablePanelHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

mock.module("@/lib/open-file", () => ({
  dispatchOpenFile: (path: string) => openedFiles.push(path),
}));

mock.module("@/queries/use-git-mutations", () => ({
  useRevertToHeadMutation: () => ({ mutateAsync: revertToHead }),
}));

mock.module("@/queries/use-repo-queries", () => ({
  useDiffQuery: () => ({
    data: {
      files: [
        {
          oldPath: "src/a.ts",
          newPath: "src/a.ts",
          status: "modified",
          additions: 1,
          deletions: 0,
        },
        {
          oldPath: "src/b.ts",
          newPath: "src/b.ts",
          status: "modified",
          additions: 0,
          deletions: 1,
        },
        { oldPath: "old/c.ts", newPath: "src/c.ts", status: "renamed", additions: 0, deletions: 0 },
        {
          oldPath: "src/a.ts",
          newPath: "src/copy.ts",
          status: "copied",
          additions: 0,
          deletions: 0,
        },
      ],
    },
  }),
}));

const { FileTreePanel } = await import("./FileTreePanel");

function renderPanel() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <FileTreePanel />
    </QueryClientProvider>,
  );
}

async function openMenu(name: RegExp) {
  fireEvent.contextMenu(await screen.findByRole("button", { name }));
}

describe("FileTreePanel", () => {
  beforeEach(() => {
    revertToHead.mockClear();
    openedFiles.length = 0;
    missingPaths.clear();
    useWorktreeStore.setState({ activeWorktreePath: "/repo" });
    setActiveWorktreeKey("/repo");
    getCurrentWorktreeUI().getState().setSelectedDiffFile("src/a.ts");
    getCurrentWorktreeUI().getState().setPendingReveal(null);
    getCurrentRepositoryStore()
      .getState()
      .setDiffSource({ type: "uncommitted", worktree: "/repo" });
  });

  test("focusing a folder does not replace the selected diff file", async () => {
    renderPanel();

    const folder = await screen.findByRole("button", { name: /^src$/ });
    fireEvent.focus(folder);
    fireEvent.click(folder);

    await waitFor(() => {
      expect(getCurrentWorktreeUI().getState().selectedDiffFile).toBe("src/a.ts");
    });
  });

  test("moving focus with the keyboard does not change the diffed file; a click does", async () => {
    renderPanel();
    const selected = () => getCurrentWorktreeUI().getState().selectedDiffFile;

    const a = await screen.findByRole("button", { name: /^a\.ts/ });
    fireEvent.click(a);
    expect(selected()).toBe("src/a.ts");

    fireEvent.keyDown(a, { key: "ArrowDown" });
    const b = screen.getByRole("button", { name: /^b\.ts/ });
    expect(document.activeElement).toBe(b);
    expect(selected()).toBe("src/a.ts");
    expect(a).toHaveAttribute("data-tree-active");
    expect(b).not.toHaveAttribute("data-tree-active");

    fireEvent.click(b);
    expect(selected()).toBe("src/b.ts");
    expect(b).toHaveAttribute("data-tree-active");
  });

  test("Enter and double-click select the file and open the diff viewer", async () => {
    renderPanel();
    const openDiff = jest.fn();
    window.addEventListener("loxel-open-diff", openDiff);

    const b = await screen.findByRole("button", { name: /^b\.ts/ });
    b.focus();
    expect(getCurrentWorktreeUI().getState().selectedDiffFile).toBe("src/a.ts");
    fireEvent.keyDown(b, { key: "Enter" });
    expect(getCurrentWorktreeUI().getState().selectedDiffFile).toBe("src/b.ts");
    expect(openDiff).toHaveBeenCalledTimes(1);

    fireEvent.doubleClick(screen.getByRole("button", { name: /^c\.ts/ }));
    expect(getCurrentWorktreeUI().getState().selectedDiffFile).toBe("src/c.ts");
    expect(openDiff).toHaveBeenCalledTimes(2);

    window.removeEventListener("loxel-open-diff", openDiff);
  });

  test("opens a file from the context menu", async () => {
    renderPanel();

    await openMenu(/b\.ts/);
    const openFile = await screen.findByRole("menuitem", { name: "Open File" });
    await waitFor(() => expect(openFile.hasAttribute("data-disabled")).toBe(false));
    fireEvent.click(openFile);

    expect(openedFiles).toEqual(["/repo/src/b.ts"]);
  });

  test("reveals a file in the project explorer", async () => {
    renderPanel();

    await openMenu(/b\.ts/);
    const reveal = await screen.findByRole("menuitem", { name: "Reveal in Project Explorer" });
    await waitFor(() => expect(reveal.hasAttribute("data-disabled")).toBe(false));
    fireEvent.click(reveal);

    expect(getCurrentWorktreeUI().getState().pendingReveal).toEqual({
      path: "/repo/src/b.ts",
      expand: false,
    });
  });

  test("discards a folder's local changes, including both sides of renames", async () => {
    renderPanel();

    await openMenu(/^src$/);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Discard Changes" }));
    expect(await screen.findByText(/4 files in "src"\? New files will be deleted/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));

    await waitFor(() => {
      expect(revertToHead).toHaveBeenCalledWith({
        worktree: "/repo",
        files: ["src/a.ts", "src/b.ts", "old/c.ts", "src/c.ts", "src/copy.ts"],
      });
    });
  });

  test("discarding a copy leaves its source alone", async () => {
    renderPanel();

    await openMenu(/copy\.ts/);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Discard Changes" }));
    expect(await screen.findByText(/It is a new file and will be deleted/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));

    await waitFor(() => {
      expect(revertToHead).toHaveBeenCalledWith({ worktree: "/repo", files: ["src/copy.ts"] });
    });
  });

  test("disables the items acting on disk when the path is gone", async () => {
    missingPaths.add("/repo/src/b.ts");
    renderPanel();

    await openMenu(/b\.ts/);
    const openFile = await screen.findByRole("menuitem", { name: "Open File" });
    const reveal = screen.getByRole("menuitem", { name: "Reveal in Project Explorer" });
    await waitFor(() => {
      expect(openFile.hasAttribute("data-disabled")).toBe(true);
      expect(reveal.hasAttribute("data-disabled")).toBe(true);
    });
    expect(screen.getByRole("menuitem", { name: "Open Diff" }).hasAttribute("data-disabled")).toBe(
      false,
    );
  });

  test.each([
    ["Copy Name", "b.ts"],
    ["Copy Relative Path", "src/b.ts"],
    ["Copy Absolute Path", "/repo/src/b.ts"],
  ])("%s copies %s", async (item, expected) => {
    const writeText = mock((_text: string) => Promise.resolve());
    const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    try {
      renderPanel();

      await openMenu(/b\.ts/);
      fireEvent.click(await screen.findByRole("menuitem", { name: item }));

      expect(writeText).toHaveBeenCalledWith(expected);
    } finally {
      if (original) Object.defineProperty(navigator, "clipboard", original);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  test("offers no discard for a commit's changes", async () => {
    getCurrentRepositoryStore().getState().setDiffSource({ type: "commit", commit: "abc1234" });
    renderPanel();

    await openMenu(/b\.ts/);
    expect(await screen.findByRole("menuitem", { name: "Open Diff" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Discard Changes" })).toBeNull();
  });

  test("only discards for another worktree's local changes", async () => {
    getCurrentRepositoryStore()
      .getState()
      .setDiffSource({ type: "uncommitted", worktree: "/other" });
    renderPanel();

    await openMenu(/b\.ts/);
    const discard = await screen.findByRole("menuitem", { name: "Discard Changes" });
    expect(screen.queryByRole("menuitem", { name: "Open File" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Reveal in Project Explorer" })).toBeNull();
    fireEvent.click(discard);
    fireEvent.click(await screen.findByRole("button", { name: "Discard" }));

    await waitFor(() => {
      expect(revertToHead).toHaveBeenCalledWith({ worktree: "/other", files: ["src/b.ts"] });
    });
  });
});
