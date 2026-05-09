import type { ReactNode } from "react";

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { setActiveWorktreeKey } from "@/store/worktree-store";
import { getCurrentWorktreeUI } from "@/store/worktree-ui";
import { useWorktreeStore } from "@/store/worktrees";

mock.module("@/components/panels/BranchCommitDropdown", () => ({
  BranchCommitDropdown: () => null,
}));

mock.module("@/components/panels/DraggablePanelHeader", () => ({
  DraggablePanelHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
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
      ],
    },
  }),
}));

const { FileTreePanel } = await import("./FileTreePanel");

describe("FileTreePanel", () => {
  beforeEach(() => {
    useWorktreeStore.setState({ activeWorktreePath: "/repo" });
    setActiveWorktreeKey("/repo");
    getCurrentWorktreeUI().getState().setSelectedDiffFile("src/a.ts");
  });

  test("focusing a folder does not replace the selected diff file", async () => {
    render(<FileTreePanel />);

    const folder = await screen.findByRole("button", { name: /^src$/ });
    fireEvent.focus(folder);
    fireEvent.click(folder);

    await waitFor(() => {
      expect(getCurrentWorktreeUI().getState().selectedDiffFile).toBe("src/a.ts");
    });
  });
});
