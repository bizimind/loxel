import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { DiffFileContext, PlacedThread } from "@/api/review-model";
import { useWorktreeStore } from "@/store/worktrees";

/** Pending placed-threads requests, resolved by the test in any order */
const pending: ((threads: PlacedThread[]) => void)[] = [];
const originalClient = await import("@/api/client");
mock.module("@/api/client", () => ({
  ...originalClient,
  postPlacedThreads: () =>
    new Promise<PlacedThread[]>((resolve) => {
      pending.push(resolve);
    }),
}));

const { useCommentStore } = await import("./comments");

const FILES: DiffFileContext[] = [
  { oldPath: "a.ts", newPath: "a.ts", oldRef: "abc", newRef: null, worktreePath: "/repo" },
];

function thread(id: string): PlacedThread {
  return {
    id,
    reviewId: "r1",
    filePath: "a.ts",
    createdSide: "new",
    contentAnchor: { content: ["x"], contextBefore: [], contextAfter: [], contentHash: "h" },
    startLine: 1,
    endLine: 1,
    status: "open",
    createdAt: "",
    updatedAt: "",
    comments: [],
    displaySide: "new",
    displayStartLine: 1,
    displayEndLine: 1,
    anchorStatus: "exact",
  };
}

const placedIds = () =>
  [...useCommentStore.getState().placedThreadsByFile.values()].flat().map((t) => t.id);

describe("fetchPlacedThreads", () => {
  beforeEach(() => {
    pending.length = 0;
    useWorktreeStore.setState({ activeWorktreePath: "/repo" });
    useCommentStore.getState().clearAll();
  });

  test("an earlier fetch answering last does not overwrite a later one", async () => {
    const { fetchPlacedThreads } = useCommentStore.getState();
    const first = fetchPlacedThreads(["r1"], FILES);
    const second = fetchPlacedThreads(["r1"], FILES);
    pending[1]?.([thread("new")]);
    await second;
    pending[0]?.([thread("old")]);
    await first;
    expect(placedIds()).toEqual(["new"]);
    expect(useCommentStore.getState().loading).toBe(false);
  });

  test("a fetch answering after clearAll is dropped", async () => {
    const fetch = useCommentStore.getState().fetchPlacedThreads(["r1"], FILES);
    useCommentStore.getState().clearAll();
    pending[0]?.([thread("stale")]);
    await fetch;
    expect(placedIds()).toEqual([]);
  });
});
