import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";

import type { CommitInfo } from "@/api/git-models";
import { purgeWorktreeStores } from "@/store/worktree-store";
import { getWorktreeUI } from "@/store/worktree-ui";
import { useWorktreeStore } from "@/store/worktrees";

const commit: CommitInfo = {
  hash: "a".repeat(40),
  shortHash: "aaaaaaa",
  parents: [],
  message: "Initial commit",
  author: "Ada",
  authorEmail: "ada@example.com",
  authorDate: "2026-01-01T00:00:00Z",
  committer: "Ada",
  committerEmail: "ada@example.com",
  committerDate: "2026-01-01T00:00:00Z",
  refs: [],
};
const commitsData = { data: { commits: [commit] } };
const statusesData = { data: [] };

mock.module("@/queries/use-repo-queries", () => ({
  useCommitsQuery: () => commitsData,
  useWorktreeStatusesQuery: () => statusesData,
}));

mock.module("../menus/CommitMenu", () => ({ CommitContextMenu: () => null }));

const { CommitGraph } = await import("./CommitGraph");

afterEach(() => {
  cleanup();
  purgeWorktreeStores("/repo");
  mock.restore();
});

describe("CommitGraph", () => {
  // On reload, `activeWorktreePath` comes back from session storage before anything switches
  // worktrees. Setting only it is that state: the first-visit graph width must land in the
  // worktree's store once, not loop on a store the component doesn't render from (#345).
  test("sets the graph column width without looping when the active worktree was restored on reload", async () => {
    const consoleError = spyOn(console, "error");
    useWorktreeStore.setState({ activeWorktreePath: "/repo" });

    render(
      <QueryClientProvider client={new QueryClient()}>
        <CommitGraph />
      </QueryClientProvider>,
    );

    await screen.findByText("Initial commit");
    expect(getWorktreeUI("/repo").getState().graphColumnSizing.graph).toBeGreaterThan(0);
    const loopErrors = consoleError.mock.calls.filter((args) =>
      args.some((arg) => String(arg).includes("Maximum update depth exceeded")),
    );
    expect(loopErrors).toEqual([]);
  });
});
