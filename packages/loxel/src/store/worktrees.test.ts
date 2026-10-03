import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { RemoveWorktreePlan } from "@/api/client";
import type { WorktreeEntry } from "@/api/git-models";

const PROJECT = "/repo";
const WT_PATH = "/repo/.worktrees/feat-x";

let plan: RemoveWorktreePlan;
let removeCalls: { wtPath: string; options: { deleteBranch: boolean; force: boolean } }[] = [];
let planRemoveCalls: string[] = [];
let branchDeleteSucceeds = true;
let listResult: { worktrees: WorktreeEntry[] } = { worktrees: [] };
let listResponses: Array<Promise<{ worktrees: WorktreeEntry[] }>> = [];
/** When set, the removal request does not resolve until this does. */
let removeGate: Promise<void> | null = null;

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
    return (removeGate ?? Promise.resolve()).then(() => ({
      name: "feat-x",
      path: wtPath,
      removed: true,
      branchDeleted: options.deleteBranch && branchDeleteSucceeds,
      hookRan: false,
    }));
  },
  getProjectWorktrees: () => listResponses.shift() ?? Promise.resolve(listResult),
}));

const { deriveOwningWorktree, useWorktreeStore } = await import("./worktrees");
const { useProjectStore } = await import("./projects");

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
  listResult = { worktrees: [] };
  listResponses = [];
  removeGate = null;
  plan = {
    name: "feat-x",
    worktreePath: WT_PATH,
    branch: "feat-x",
    dirty: true,
    isMain: false,
    locked: false,
  };
  useWorktreeStore.setState({
    byProject: { [PROJECT]: { worktrees: [worktree] } },
    pendingRemovePlan: null,
    pendingAddPlan: null,
  });
});

describe("refreshProjectWorktrees", () => {
  const other: WorktreeEntry = {
    ...worktree,
    path: "/repo/.worktrees/other",
    branch: "other",
    wtName: "other",
  };

  test("falls back to a surviving worktree for a bare project", async () => {
    useProjectStore.setState({
      projects: [
        {
          id: "p1",
          path: PROJECT,
          name: "repo",
          addedAt: "",
          isBare: true,
          worktreesDir: "/repo/.worktrees",
          worktrees: [worktree, other],
        },
      ],
    });
    useWorktreeStore.setState({ activeWorktreePath: WT_PATH });
    listResult = { worktrees: [other] };

    await useWorktreeStore.getState().refreshProjectWorktrees(PROJECT);

    expect(useWorktreeStore.getState().activeWorktreePath).toBe(other.path);
  });

  test("falls back to the root checkout for a regular project", async () => {
    useProjectStore.setState({
      projects: [
        {
          id: "p1",
          path: PROJECT,
          name: "repo",
          addedAt: "",
          isBare: false,
          worktreesDir: "/repo/.worktrees",
          worktrees: [worktree],
        },
      ],
    });
    useWorktreeStore.setState({ activeWorktreePath: WT_PATH });

    await useWorktreeStore.getState().refreshProjectWorktrees(PROJECT);

    expect(useWorktreeStore.getState().activeWorktreePath).toBe(PROJECT);
  });

  test("keeps the regular project's root checkout active", async () => {
    useProjectStore.setState({
      projects: [
        {
          id: "p1",
          path: PROJECT,
          name: "repo",
          addedAt: "",
          isBare: false,
          worktreesDir: "/repo/.worktrees",
          worktrees: [],
        },
      ],
    });
    useWorktreeStore.setState({ activeWorktreePath: PROJECT });

    await useWorktreeStore.getState().refreshProjectWorktrees(PROJECT);

    expect(useWorktreeStore.getState().activeWorktreePath).toBe(PROJECT);
  });

  test("does not disturb a similarly prefixed different project", async () => {
    const active = "/repo-other/.worktrees/topic";
    useProjectStore.setState({
      projects: [
        {
          id: "p1",
          path: PROJECT,
          name: "repo",
          addedAt: "",
          isBare: true,
          worktreesDir: "/repo/.worktrees",
          worktrees: [worktree],
        },
        {
          id: "p2",
          path: "/repo-other",
          name: "other repo",
          addedAt: "",
          isBare: true,
          worktreesDir: "/repo-other/.worktrees",
          worktrees: [{ ...other, path: active }],
        },
      ],
    });
    useWorktreeStore.setState({ activeWorktreePath: active });

    await useWorktreeStore.getState().refreshProjectWorktrees(PROJECT);

    expect(useWorktreeStore.getState().activeWorktreePath).toBe(active);
  });

  test("recognizes stale external WT_DIR membership from the worktree store", async () => {
    const external = "/external/worktrees/topic";
    useProjectStore.setState({
      projects: [
        {
          id: "p1",
          path: PROJECT,
          name: "repo",
          addedAt: "",
          isBare: true,
          worktreesDir: "/external/worktrees",
          // Deliberately stale: the single-project refresh does not update this snapshot.
          worktrees: [],
        },
      ],
    });
    useWorktreeStore.setState({
      activeWorktreePath: external,
      byProject: { [PROJECT]: { worktrees: [{ ...worktree, path: external }] } },
    });

    await useWorktreeStore.getState().refreshProjectWorktrees(PROJECT);

    expect(useWorktreeStore.getState().activeWorktreePath).toBeNull();
  });

  test("ignores an older refresh response that resolves after a newer one", async () => {
    let resolveOlder: (value: { worktrees: WorktreeEntry[] }) => void = () => {};
    let resolveNewer: (value: { worktrees: WorktreeEntry[] }) => void = () => {};
    listResponses = [
      new Promise((resolve) => {
        resolveOlder = resolve;
      }),
      new Promise((resolve) => {
        resolveNewer = resolve;
      }),
    ];
    useProjectStore.setState({
      projects: [
        {
          id: "p1",
          path: PROJECT,
          name: "repo",
          addedAt: "",
          isBare: true,
          worktreesDir: "/repo/.worktrees",
          worktrees: [worktree, other],
        },
      ],
    });
    useWorktreeStore.setState({ activeWorktreePath: other.path });

    const older = useWorktreeStore.getState().refreshProjectWorktrees(PROJECT);
    const newer = useWorktreeStore.getState().refreshProjectWorktrees(PROJECT);
    resolveNewer({ worktrees: [other] });
    await newer;
    resolveOlder({ worktrees: [] });
    await older;

    expect(useWorktreeStore.getState().byProject[PROJECT]?.worktrees).toEqual([other]);
    expect(useWorktreeStore.getState().activeWorktreePath).toBe(other.path);
  });

  test("does not reuse request IDs after the store resets", async () => {
    let resolveBeforeReset: (value: { worktrees: WorktreeEntry[] }) => void = () => {};
    let resolveAfterReset: (value: { worktrees: WorktreeEntry[] }) => void = () => {};
    listResponses = [
      new Promise((resolve) => {
        resolveBeforeReset = resolve;
      }),
      new Promise((resolve) => {
        resolveAfterReset = resolve;
      }),
    ];
    useProjectStore.setState({
      projects: [
        {
          id: "p1",
          path: PROJECT,
          name: "repo",
          addedAt: "",
          isBare: true,
          worktreesDir: "/repo/.worktrees",
          worktrees: [other],
        },
      ],
    });

    const beforeReset = useWorktreeStore.getState().refreshProjectWorktrees(PROJECT);
    useWorktreeStore.getState().reset();
    useWorktreeStore.setState({ activeWorktreePath: other.path });
    const afterReset = useWorktreeStore.getState().refreshProjectWorktrees(PROJECT);
    resolveAfterReset({ worktrees: [other] });
    await afterReset;
    resolveBeforeReset({ worktrees: [] });
    await beforeReset;

    expect(useWorktreeStore.getState().byProject[PROJECT]?.worktrees).toEqual([other]);
    expect(useWorktreeStore.getState().activeWorktreePath).toBe(other.path);
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
  // Removal refreshes the list, which only runs for a project the project store knows.
  beforeEach(() => {
    useProjectStore.setState({
      projects: [
        {
          id: "p1",
          path: PROJECT,
          name: "repo",
          addedAt: "",
          isBare: true,
          worktreesDir: "/repo/.worktrees",
          worktrees: [worktree],
        },
      ],
    });
  });

  test("keeps the entry, marked removing, until the server confirms the removal", async () => {
    let finishRemoval: () => void = () => {};
    removeGate = new Promise((resolve) => {
      finishRemoval = resolve;
    });
    await useWorktreeStore.getState().requestRemoveWorktree(PROJECT, worktree);

    const removal = useWorktreeStore
      .getState()
      .confirmRemoveWorktree({ deleteBranch: false, force: false });
    expect(useWorktreeStore.getState().byProject[PROJECT]?.worktrees).toEqual([
      { ...worktree, pending: "removing" },
    ]);

    // A list refresh while the request is in flight keeps the marker.
    listResult = { worktrees: [worktree] };
    await useWorktreeStore.getState().refreshProjectWorktrees(PROJECT);
    expect(useWorktreeStore.getState().byProject[PROJECT]?.worktrees?.[0]?.pending).toBe(
      "removing",
    );

    listResult = { worktrees: [] };
    finishRemoval();
    await removal;
    expect(useWorktreeStore.getState().byProject[PROJECT]?.worktrees).toEqual([]);
  });

  test("forwards the user's force and deleteBranch choices", async () => {
    await useWorktreeStore.getState().requestRemoveWorktree(PROJECT, worktree);
    await useWorktreeStore.getState().confirmRemoveWorktree({ deleteBranch: true, force: true });

    expect(removeCalls).toEqual([
      { wtPath: WT_PATH, options: { deleteBranch: true, force: true } },
    ]);
    expect(useWorktreeStore.getState().pendingRemovePlan).toBeNull();
    expect(useWorktreeStore.getState().byProject[PROJECT]?.worktrees).toEqual([]);
  });

  test("restores the entry when the removal fails", async () => {
    removeGate = Promise.reject(new Error("locked"));
    listResult = { worktrees: [worktree] };
    await useWorktreeStore.getState().requestRemoveWorktree(PROJECT, worktree);

    await expect(
      useWorktreeStore.getState().confirmRemoveWorktree({ deleteBranch: false, force: false }),
    ).rejects.toThrow("locked");
    expect(useWorktreeStore.getState().byProject[PROJECT]?.worktrees).toEqual([worktree]);
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

  test("surfaces partial success when the branch could not be deleted", async () => {
    branchDeleteSucceeds = false;
    await useWorktreeStore.getState().requestRemoveWorktree(PROJECT, worktree);

    await expect(
      useWorktreeStore.getState().confirmRemoveWorktree({ deleteBranch: true, force: true }),
    ).rejects.toThrow("worktree was removed");

    expect(useWorktreeStore.getState().byProject[PROJECT]?.worktrees).toEqual([]);
  });
});

describe("deriveOwningWorktree", () => {
  function project(path: string, worktreePaths: string[], isBare = false) {
    return { path, isBare, worktrees: worktreePaths.map((p) => worktree(p)) };
  }
  function worktree(path: string): WorktreeEntry {
    return { path, branch: "topic", commit: "abc", isMain: false, createdAt: null };
  }

  test("picks the deepest worktree containing the path", () => {
    const projects = [project("/repos/app", ["/repos/app/.worktrees/topic"])];

    expect(deriveOwningWorktree("/repos/app/.worktrees/topic/src", projects, {})).toBe(
      "/repos/app/.worktrees/topic",
    );
    expect(deriveOwningWorktree("/repos/app/src", projects, {})).toBe("/repos/app");
  });

  test("uses the live worktree list over the projects snapshot", () => {
    const projects = [project("/repos/app", [])];
    const byProject = { "/repos/app": { worktrees: [worktree("/repos/app/.worktrees/new")] } };

    expect(deriveOwningWorktree("/repos/app/.worktrees/new/src", projects, byProject)).toBe(
      "/repos/app/.worktrees/new",
    );
  });

  test("ignores a bare repo's root, which is not a worktree", () => {
    const projects = [project("/repos/bare", ["/repos/bare/main"], true)];

    expect(deriveOwningWorktree("/repos/bare/main/docs", projects, {})).toBe("/repos/bare/main");
    expect(deriveOwningWorktree("/repos/bare/hooks", projects, {})).toBeNull();
  });

  test("returns null outside every project", () => {
    const projects = [project("/repos/app", [])];

    expect(deriveOwningWorktree("/notes", projects, {})).toBeNull();
    expect(deriveOwningWorktree("/repos/app-other", projects, {})).toBeNull();
  });
});
