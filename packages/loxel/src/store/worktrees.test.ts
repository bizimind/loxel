import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

import type { AddWorktreePlan } from "@/api/client";
import type { WorktreeEntry } from "@/api/git-models";
import type { WorktreeRemovePlan } from "@/api/worktree-removal-model";

const PROJECT = "/repo";
const WT_PATH = "/repo/.worktrees/feat-x";
const NEW_PATH = "/repo/.worktrees/new-wt";

let plan: WorktreeRemovePlan;
let removeCalls: {
  wtPath: string;
  options: { deleteBranch: boolean; force: boolean; nested?: string };
}[] = [];
let planRemoveCalls: string[] = [];
let branchDeleteSucceeds = true;
let listResult: { worktrees: WorktreeEntry[] } = { worktrees: [] };
let listResponses: Array<Promise<{ worktrees: WorktreeEntry[] }>> = [];
/** When set, the removal request does not resolve until this does. */
let removeGate: Promise<void> | null = null;
let addPlan: AddWorktreePlan;
let createCalls: string[] = [];
/** When set, the create request does not resolve until this does. */
let createGate: Promise<void> | null = null;
let toasts: string[] = [];
let createHookSkipped = false;
let initHookOffers: string[] = [];

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
    options: { deleteBranch: boolean; force: boolean; nested?: string },
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
  planAddWorktree: () => Promise.resolve(addPlan),
  createWorktree: (_projectPath: string, name: string) => {
    createCalls.push(name);
    return (createGate ?? Promise.resolve()).then(() => ({
      path: NEW_PATH,
      hookRan: false,
      ...(createHookSkipped ? { hookSkipped: true } : {}),
    }));
  },
}));
mock.module("@/lib/repo-trust-dialog", () => ({
  offerToRunInitHook: (_projectPath: string, wtPath: string) => {
    initHookOffers.push(wtPath);
    return Promise.resolve();
  },
}));
mock.module("@/components/ui/toast", () => ({
  showToast: (message: string) => toasts.push(message),
}));

const { queryClient } = await import("@/query-client");
const { queryKeys } = await import("@/queries/query-keys");
const { useFileSearchStore } = await import("./file-search");
const { registerLayoutCache } = await import("./worktree-cache");
const { getWorktreeUI } = await import("./worktree-ui");
const {
  deriveOwningWorktree,
  isListedWorktree,
  getNumberedWorktrees,
  getWorktreeRows,
  getWorktreeTrees,
  mergePersistedProjectStates,
  persistedProjectStates,
  toggleArchivedPaths,
  useWorktreeStore,
} = await import("./worktrees");
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
  createCalls = [];
  createGate = null;
  toasts = [];
  createHookSkipped = false;
  initHookOffers = [];
  addPlan = { name: "new-wt", worktreePath: NEW_PATH, branch: "new-wt" };
  plan = {
    name: "feat-x",
    worktreePath: WT_PATH,
    branch: "feat-x",
    dirty: true,
    isMain: false,
    locked: false,
    hasHook: false,
    nested: [],
    cleanHookHeld: false,
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
          worktreeMetadata: false,
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
          worktreeMetadata: false,
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
          worktreeMetadata: false,
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
          worktreeMetadata: false,
          worktrees: [worktree],
        },
        {
          id: "p2",
          path: "/repo-other",
          name: "other repo",
          addedAt: "",
          isBare: true,
          worktreesDir: "/repo-other/.worktrees",
          worktreeMetadata: false,
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
          worktreeMetadata: false,
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
          worktreeMetadata: false,
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
          worktreeMetadata: false,
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

describe("a worktree removed outside the app", () => {
  const OTHER_WT = "/repo/.worktrees/other";

  beforeEach(() => {
    useProjectStore.setState({
      projects: [
        { id: "p", path: PROJECT, name: "repo", addedAt: "", isBare: true, worktrees: [] },
      ] as never,
    });
    useWorktreeStore.setState({
      activeWorktreePath: OTHER_WT,
      byProject: {
        [PROJECT]: { worktrees: [worktree, { ...worktree, path: OTHER_WT, wtName: "other" }] },
      },
    });
    listResult = { worktrees: [{ ...worktree, path: OTHER_WT, wtName: "other" }] };
  });

  test("releases a worktree that was not the active one", async () => {
    const worktreeUi = getWorktreeUI(WT_PATH);
    worktreeUi.getState().queueOpen({ kind: "file", filePath: `${WT_PATH}/a.ts` } as never);
    const layoutCache = new Map<string, unknown>([
      [WT_PATH, {}],
      [OTHER_WT, {}],
    ]);
    const unregister = registerLayoutCache(layoutCache);
    useFileSearchStore.getState().setFiles(WT_PATH, ["a.ts"], false);
    useFileSearchStore.getState().recordOpen(WT_PATH, "a.ts");
    queryClient.setQueryData(queryKeys.status(PROJECT, WT_PATH), { stale: true });
    queryClient.setQueryData(queryKeys.dirContents(PROJECT, `${WT_PATH}/src`), []);
    queryClient.setQueryData(queryKeys.status(PROJECT, OTHER_WT), { kept: true });
    const sent: unknown[] = [];
    const send = spyOn(actualClient.wsClient, "send").mockImplementation((message) => {
      sent.push(message);
    });

    try {
      await useWorktreeStore.getState().refreshProjectWorktrees(PROJECT);

      expect(useWorktreeStore.getState().activeWorktreePath).toBe(OTHER_WT);
      expect(getWorktreeUI(WT_PATH)).not.toBe(worktreeUi);
      expect(layoutCache.has(WT_PATH)).toBe(false);
      expect(layoutCache.has(OTHER_WT)).toBe(true);
      expect(useFileSearchStore.getState().indexByWorktree.has(WT_PATH)).toBe(false);
      expect(useFileSearchStore.getState().mruByWorktree.has(WT_PATH)).toBe(false);
      expect(queryClient.getQueryData(queryKeys.status(PROJECT, WT_PATH))).toBeUndefined();
      expect(
        queryClient.getQueryData(queryKeys.dirContents(PROJECT, `${WT_PATH}/src`)),
      ).toBeUndefined();
      const kept: unknown = queryClient.getQueryData(queryKeys.status(PROJECT, OTHER_WT));
      expect(kept).toEqual({ kept: true });
      expect(sent).toContainEqual({ type: "unsubscribe_worktree", worktreePath: WT_PATH });
      expect(isListedWorktree(WT_PATH)).toBe(false);
      expect(isListedWorktree(OTHER_WT)).toBe(true);
    } finally {
      send.mockRestore();
      unregister();
      queryClient.clear();
    }
  });

  test("leaves an entry still being created alone", async () => {
    useWorktreeStore.setState({
      byProject: {
        [PROJECT]: {
          worktrees: [
            { ...worktree, path: OTHER_WT, wtName: "other" },
            { ...worktree, pending: "creating" },
          ],
        },
      },
    });
    const worktreeUi = getWorktreeUI(WT_PATH);

    await useWorktreeStore.getState().refreshProjectWorktrees(PROJECT);

    expect(getWorktreeUI(WT_PATH)).toBe(worktreeUi);
  });
});

describe("applyEnrichedProjects", () => {
  const project = {
    id: "p1",
    path: PROJECT,
    name: "repo",
    addedAt: "",
    isBare: true,
    worktreesDir: "/repo/.worktrees",
    worktreeMetadata: false,
  };

  test("keeps persisted order and archived lists when the server returns no worktrees", () => {
    useWorktreeStore.setState({
      byProject: {
        [PROJECT]: { worktrees: [worktree], customOrder: [WT_PATH], archivedPaths: [WT_PATH] },
      },
    });

    useWorktreeStore.getState().applyEnrichedProjects([{ ...project, worktrees: [] }]);

    const state = useWorktreeStore.getState().byProject[PROJECT];
    expect(state?.worktrees).toEqual([worktree]);
    expect(state?.customOrder).toEqual([WT_PATH]);
    expect(state?.archivedPaths).toEqual([WT_PATH]);
  });

  test("prunes persisted lists against a non-empty server response", () => {
    const gone = "/repo/.worktrees/gone";
    useWorktreeStore.setState({
      byProject: {
        [PROJECT]: { worktrees: [worktree], customOrder: [gone, WT_PATH], archivedPaths: [gone] },
      },
    });

    useWorktreeStore.getState().applyEnrichedProjects([{ ...project, worktrees: [worktree] }]);

    const state = useWorktreeStore.getState().byProject[PROJECT];
    expect(state?.customOrder).toEqual([WT_PATH]);
    expect(state?.archivedPaths).toEqual([]);
  });
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
          worktreeMetadata: false,
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
      { wtPath: WT_PATH, options: { deleteBranch: true, force: true, nested: "move-up" } },
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

    expect(removeCalls[0]!.options).toEqual({
      deleteBranch: false,
      force: false,
      nested: "move-up",
    });
  });

  test("marks the nested worktrees removing too when they are removed with it", async () => {
    const child: WorktreeEntry = { ...worktree, path: `${WT_PATH}-child`, wtName: "feat-x-child" };
    useWorktreeStore.setState({ byProject: { [PROJECT]: { worktrees: [worktree, child] } } });
    plan = { ...plan, nested: [{ path: child.path, dirty: false }] };
    let release: () => void = () => {};
    removeGate = new Promise((resolve) => {
      release = resolve;
    });
    await useWorktreeStore.getState().requestRemoveWorktree(PROJECT, worktree);

    const done = useWorktreeStore
      .getState()
      .confirmRemoveWorktree({ deleteBranch: false, force: false, nested: "remove" });
    expect(
      useWorktreeStore.getState().byProject[PROJECT]?.worktrees.map((wt) => wt.pending),
    ).toEqual(["removing", "removing"]);
    release();
    await done;
    expect(removeCalls[0]!.options.nested).toBe("remove");
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

describe("createWorktree", () => {
  const created: WorktreeEntry = {
    ...worktree,
    path: NEW_PATH,
    branch: "new-wt",
    wtName: "new-wt",
  };
  const pendingOf = (path: string) =>
    useWorktreeStore.getState().byProject[PROJECT]?.worktrees.find((wt) => wt.path === path)
      ?.pending;

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
          worktreeMetadata: false,
          worktrees: [worktree],
        },
      ],
    });
  });

  test("resolves once started and keeps the entry pending, across refreshes, until it finishes", async () => {
    let finishCreate: () => void = () => {};
    createGate = new Promise((resolve) => {
      finishCreate = resolve;
    });

    const started = await useWorktreeStore.getState().createWorktree(PROJECT, "new-wt");
    expect(started).not.toBeNull();
    expect(pendingOf(NEW_PATH)).toBe("creating");

    // Before git has registered it, then after (while the init hook still runs).
    listResult = { worktrees: [worktree] };
    await useWorktreeStore.getState().refreshProjectWorktrees(PROJECT);
    expect(pendingOf(NEW_PATH)).toBe("creating");
    listResult = { worktrees: [worktree, created] };
    await useWorktreeStore.getState().refreshProjectWorktrees(PROJECT);
    expect(pendingOf(NEW_PATH)).toBe("creating");

    finishCreate();
    expect(await started?.created).toBe(true);
    expect(useWorktreeStore.getState().byProject[PROJECT]?.worktrees).toEqual([worktree, created]);
    expect(toasts).toEqual([]);
    expect(initHookOffers).toEqual([]);
  });

  test("offers to run init.wt.sh when the create held it back", async () => {
    createHookSkipped = true;
    listResult = { worktrees: [worktree, created] };

    const started = await useWorktreeStore.getState().createWorktree(PROJECT, "new-wt");

    expect(await started?.created).toBe(true);
    expect(initHookOffers).toEqual([NEW_PATH]);
  });

  test("a second create of a worktree still being created does not start", async () => {
    createGate = new Promise(() => {});
    await useWorktreeStore.getState().createWorktree(PROJECT, "new-wt");

    await expect(useWorktreeStore.getState().createWorktree(PROJECT, "new-wt")).rejects.toThrow(
      "already being created",
    );
    expect(createCalls).toEqual(["new-wt"]);
  });

  test("reloading the projects mid-create keeps the entry pending", async () => {
    createGate = new Promise(() => {});
    await useWorktreeStore.getState().createWorktree(PROJECT, "new-wt");
    const project = useProjectStore.getState().projects[0]!;

    useWorktreeStore.getState().applyEnrichedProjects([{ ...project, worktrees: [worktree] }]);
    expect(pendingOf(NEW_PATH)).toBe("creating");
    useWorktreeStore
      .getState()
      .applyEnrichedProjects([{ ...project, worktrees: [worktree, created] }]);
    expect(pendingOf(NEW_PATH)).toBe("creating");
  });

  test("a failed create drops the entry and reports the reason as a toast", async () => {
    createGate = Promise.reject(new Error("Branch 'new-wt' is already checked out"));
    listResult = { worktrees: [worktree] };

    const started = await useWorktreeStore.getState().createWorktree(PROJECT, "new-wt");

    expect(await started?.created).toBe(false);
    expect(useWorktreeStore.getState().byProject[PROJECT]?.worktrees).toEqual([worktree]);
    expect(toasts).toEqual([
      "Could not create worktree 'new-wt': Branch 'new-wt' is already checked out",
    ]);
  });

  test("a branch that exists parks the plan for the dialog and starts nothing", async () => {
    addPlan = { ...addPlan, branchConflict: { kind: "exists" } };

    expect(await useWorktreeStore.getState().createWorktree(PROJECT, "new-wt")).toBeNull();

    expect(useWorktreeStore.getState().pendingAddPlan?.name).toBe("new-wt");
    expect(createCalls).toEqual([]);
    expect(pendingOf(NEW_PATH)).toBeUndefined();
  });

  test("confirming a parked plan starts the create the same way", async () => {
    addPlan = { ...addPlan, branchConflict: { kind: "exists" } };
    await useWorktreeStore.getState().createWorktree(PROJECT, "new-wt");
    listResult = { worktrees: [worktree, created] };

    const started = await useWorktreeStore.getState().confirmCreateWorktree("use-existing");

    expect(useWorktreeStore.getState().pendingAddPlan).toBeNull();
    expect(await started?.created).toBe(true);
    expect(createCalls).toEqual(["new-wt"]);
    expect(pendingOf(NEW_PATH)).toBeUndefined();
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

describe("worktree nesting", () => {
  const parent: WorktreeEntry = { ...worktree, wtId: "id-parent" };
  const child: WorktreeEntry = {
    ...worktree,
    path: "/repo/.worktrees/child",
    wtName: "child",
    wtId: "id-child",
    parentWtId: "id-parent",
  };
  const loose: WorktreeEntry = { ...worktree, path: "/repo/.worktrees/loose", wtName: "loose" };

  test("numbers worktrees in visible order, skipping archived and collapsed subtrees", () => {
    const ps = { worktrees: [parent, child, loose], customOrder: [WT_PATH, loose.path] };
    expect(getNumberedWorktrees(ps).map((wt) => wt.path)).toEqual([
      WT_PATH,
      child.path,
      loose.path,
    ]);
    expect(getNumberedWorktrees({ ...ps, collapsedPaths: [WT_PATH] }).map((wt) => wt.path)).toEqual(
      [WT_PATH, loose.path],
    );
    expect(getNumberedWorktrees({ ...ps, archivedPaths: [WT_PATH] }).map((wt) => wt.path)).toEqual([
      loose.path,
    ]);
  });

  test("persists and merges collapsed worktrees with the other lists", () => {
    const persisted = persistedProjectStates({
      [PROJECT]: { worktrees: [parent], collapsedPaths: [WT_PATH] },
      "/empty": { worktrees: [] },
    });
    expect(persisted).toEqual({ [PROJECT]: { collapsedPaths: [WT_PATH] } });

    const merged = mergePersistedProjectStates(
      { [PROJECT]: { worktrees: [parent] } },
      { [PROJECT]: { collapsedPaths: [WT_PATH, 3], archivedPaths: "bad" } },
    );
    expect(merged[PROJECT]).toEqual({ worktrees: [parent], collapsedPaths: [WT_PATH] });
  });

  test("brings worktrees saved as hidden back archived", () => {
    const merged = mergePersistedProjectStates(
      { [PROJECT]: { worktrees: [parent] } },
      { [PROJECT]: { hiddenPaths: [WT_PATH] } },
    );
    expect(merged[PROJECT]?.archivedPaths).toEqual([WT_PATH]);
  });

  test("lists archived worktrees, with their nested ones, only in the Archive group", () => {
    const ps = { worktrees: [parent, child, loose], archivedPaths: [WT_PATH] };
    expect(getWorktreeRows(ps).map((row) => row.wt.path)).toEqual([loose.path]);
    const [archivedRoot, ...others] = getWorktreeTrees(ps).archived;
    expect(others).toEqual([]);
    expect(archivedRoot?.wt.path).toBe(WT_PATH);
    expect(archivedRoot?.children.map((node) => node.wt.path)).toEqual([child.path]);
  });

  test("archiving covers the archived worktrees below it, and bringing one back brings its archived ancestor's subtree back", () => {
    const worktrees = [parent, child, loose];
    expect(toggleArchivedPaths(worktrees, [child.path], WT_PATH)).toEqual([WT_PATH]);
    expect(toggleArchivedPaths(worktrees, [WT_PATH], child.path)).toEqual([]);
    expect(toggleArchivedPaths(worktrees, [WT_PATH], loose.path)).toEqual([WT_PATH, loose.path]);
    // A worktree archived in its own right inside an archived one comes back with it.
    expect(toggleArchivedPaths(worktrees, [WT_PATH, child.path], WT_PATH)).toEqual([]);
    // ...and so does bringing back the inner one: it would stay covered by the outer one.
    expect(toggleArchivedPaths(worktrees, [WT_PATH, child.path], child.path)).toEqual([]);
  });

  test("markArchived archives a worktree in its own right, once", () => {
    useWorktreeStore.getState().markArchived(PROJECT, WT_PATH);
    useWorktreeStore.getState().markArchived(PROJECT, WT_PATH);
    expect(useWorktreeStore.getState().byProject[PROJECT]?.archivedPaths).toEqual([WT_PATH]);
  });

  test("toggleCollapsed folds and unfolds a worktree", () => {
    useWorktreeStore.getState().toggleCollapsed(PROJECT, WT_PATH);
    expect(useWorktreeStore.getState().byProject[PROJECT]?.collapsedPaths).toEqual([WT_PATH]);
    useWorktreeStore.getState().toggleCollapsed(PROJECT, WT_PATH);
    expect(useWorktreeStore.getState().byProject[PROJECT]?.collapsedPaths).toEqual([]);
  });
});
