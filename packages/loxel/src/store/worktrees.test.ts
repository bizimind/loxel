import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { RemoveWorktreePlan } from "@/api/client";
import type { WorktreeEntry } from "@/api/git-models";

const PROJECT = "/repo";
const WT_PATH = "/repo/.worktrees/feat-x";

let plan: RemoveWorktreePlan;
let removeCalls: { wtPath: string; options: { deleteBranch: boolean; force: boolean } }[] = [];
let planRemoveCalls: string[] = [];
let branchDeleteSucceeds = true;

const actualClient = await import("@/api/client");

// Override only the worktree-removal calls; the rest of the client module
// (logging, ws client) is shared with the store under test.
mock.module("@/api/client", () => ({
  ...actualClient,
  planRemoveWorktree: (_projectPath: string, wtPath: string) => {
    planRemoveCalls.push(wtPath);
    return Promise.resolve(plan);
  },
  removeWorktreeByWtPath: (
    _projectPath: string,
    wtPath: string,
    options: { deleteBranch: boolean; force: boolean },
  ) => {
    removeCalls.push({ wtPath, options });
    return Promise.resolve({
      name: "feat-x",
      path: wtPath,
      removed: true,
      branchDeleted: options.deleteBranch && branchDeleteSucceeds,
      hookRan: false,
    });
  },
  getProjectWorktrees: () => Promise.resolve({ worktrees: [] }),
}));

const { useWorktreeStore } = await import("./worktrees");

const worktree: WorktreeEntry = {
  path: WT_PATH,
  branch: "feat-x",
  commit: "abc",
  isMain: false,
  createdAt: null,
  wtName: "feat-x",
};

beforeEach(() => {
  removeCalls = [];
  planRemoveCalls = [];
  branchDeleteSucceeds = true;
  plan = { name: "feat-x", worktreePath: WT_PATH, branch: "feat-x", dirty: true, isMain: false };
  useWorktreeStore.setState({
    byProject: { [PROJECT]: { worktrees: [worktree] } },
    pendingRemovePlan: null,
    pendingAddPlan: null,
  });
});

afterEach(() => {
  useWorktreeStore.getState().reset();
});

describe("requestRemoveWorktree", () => {
  test("always stages a pending plan for confirmation", async () => {
    await useWorktreeStore.getState().requestRemoveWorktree(PROJECT, worktree);

    expect(planRemoveCalls).toEqual([WT_PATH]);
    expect(removeCalls).toEqual([]);
    expect(useWorktreeStore.getState().pendingRemovePlan).toEqual({
      ...plan,
      wtPath: WT_PATH,
      projectPath: PROJECT,
    });
  });
});

describe("confirmRemoveWorktree", () => {
  test("forwards the user's force and deleteBranch choices", async () => {
    await useWorktreeStore.getState().requestRemoveWorktree(PROJECT, worktree);
    await useWorktreeStore.getState().confirmRemoveWorktree({ deleteBranch: true, force: true });

    expect(removeCalls).toEqual([
      { wtPath: WT_PATH, options: { deleteBranch: true, force: true } },
    ]);
    expect(useWorktreeStore.getState().pendingRemovePlan).toBeNull();
    expect(useWorktreeStore.getState().byProject[PROJECT]?.worktrees).toEqual([]);
  });

  test("forwards a keep-branch, no-force removal unchanged", async () => {
    await useWorktreeStore.getState().requestRemoveWorktree(PROJECT, worktree);
    await useWorktreeStore.getState().confirmRemoveWorktree({ deleteBranch: false, force: false });

    expect(removeCalls[0]!.options).toEqual({ deleteBranch: false, force: false });
  });

  test("is a no-op without a pending plan", async () => {
    await useWorktreeStore.getState().confirmRemoveWorktree({ deleteBranch: true, force: true });
    expect(removeCalls).toEqual([]);
  });

  test("surfaces partial success when Git keeps an unmerged branch", async () => {
    branchDeleteSucceeds = false;
    await useWorktreeStore.getState().requestRemoveWorktree(PROJECT, worktree);

    await expect(
      useWorktreeStore.getState().confirmRemoveWorktree({ deleteBranch: true, force: true }),
    ).rejects.toThrow("worktree was removed");

    expect(useWorktreeStore.getState().byProject[PROJECT]?.worktrees).toEqual([]);
  });
});
