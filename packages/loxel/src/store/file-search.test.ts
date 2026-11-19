import { describe, expect, test } from "bun:test";

import { localRef } from "@/api/local-server";
import { toServerId, worktreeRef } from "@/api/worktree-ref";

import { getRecentFiles } from "./file-search";
import { purgeWorktreeStores } from "./worktree-store";

describe("Quick Open's recent files", () => {
  test("are kept per worktree: the same path on another server has its own", () => {
    const here = localRef("/repo");
    const there = worktreeRef(toServerId("other-server"), "/repo");
    getRecentFiles(here).getState().recordOpen("a.ts");
    getRecentFiles(here).getState().recordOpen("b.ts");
    getRecentFiles(here).getState().recordOpen("a.ts");

    expect(getRecentFiles(here).getState().recent).toEqual(["a.ts", "b.ts"]);
    expect(getRecentFiles(there).getState().recent).toEqual([]);

    getRecentFiles(there).getState().recordOpen("c.ts");
    purgeWorktreeStores(here);
    expect(getRecentFiles(here).getState().recent).toEqual([]);
    expect(getRecentFiles(there).getState().recent).toEqual(["c.ts"]);
  });
});
