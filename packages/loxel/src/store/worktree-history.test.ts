import { afterEach, describe, expect, test } from "bun:test";

import { localServerId } from "@/api/local-server";
import { type ServerId, toServerId, type WorktreeRef, worktreeRef } from "@/api/worktree-ref";

import { type ListedProject, useProjectStore } from "./projects";
import { goBackWorktree, goForwardWorktree, WorktreeHistory } from "./worktree-history";
import { activeWorktreeFields, useWorktreeStore } from "./worktrees";

const SERVER = toServerId("server-a");
const OTHER_SERVER = toServerId("server-b");

const ref = (path: string, server: ServerId = SERVER): WorktreeRef => worktreeRef(server, path);
const always = () => true;

describe("WorktreeHistory", () => {
  test("goes back and forward like a browser", () => {
    const history = new WorktreeHistory();
    // A → B → C
    history.record(ref("/A"));
    history.record(ref("/B"));
    expect(history.goBack(ref("/C"), always)).toEqual(ref("/B"));
    expect(history.goBack(ref("/B"), always)).toEqual(ref("/A"));
    expect(history.goBack(ref("/A"), always)).toBeNull();
    expect(history.goForward(ref("/A"), always)).toEqual(ref("/B"));
    expect(history.goForward(ref("/B"), always)).toEqual(ref("/C"));
    expect(history.goForward(ref("/C"), always)).toBeNull();
  });

  test("a new navigation clears the forward stack", () => {
    const history = new WorktreeHistory();
    history.record(ref("/A"));
    expect(history.goBack(ref("/B"), always)).toEqual(ref("/A"));
    history.record(ref("/A")); // A → D
    expect(history.goForward(ref("/D"), always)).toBeNull();
    expect(history.goBack(ref("/D"), always)).toEqual(ref("/A"));
  });

  test("skips worktrees that no longer exist and the current one", () => {
    const history = new WorktreeHistory();
    history.record(ref("/A"));
    history.record(ref("/gone"));
    history.record(ref("/C"));
    expect(history.goBack(ref("/C"), (wt) => wt.path !== "/gone")).toEqual(ref("/A"));
    expect(history.goForward(ref("/A"), always)).toEqual(ref("/C"));
  });

  test("keeps the same path on two servers apart", () => {
    const history = new WorktreeHistory();
    history.record(ref("/repo"));
    history.record(ref("/repo", OTHER_SERVER));
    // The current worktree is skipped, but the same path on the other server is not it.
    expect(history.goBack(ref("/repo"), always)).toEqual(ref("/repo", OTHER_SERVER));
    expect(history.goBack(ref("/repo", OTHER_SERVER), always)).toEqual(ref("/repo"));
  });
});

describe("goBackWorktree / goForwardWorktree", () => {
  afterEach(() => {
    useWorktreeStore.getState().reset();
    useProjectStore.setState({ projects: [] });
  });

  test("switch back and forward by ref, skipping worktrees no longer listed", async () => {
    const server = localServerId();
    const project: ListedProject = {
      server,
      id: "p",
      name: "repo",
      path: "/repo",
      addedAt: "2026-01-01T00:00:00.000Z",
      isBare: false,
      worktreesDir: "/repo/.worktrees",
      worktreeMetadata: false,
      worktrees: [],
    };
    const entry = (path: string) => ({
      path,
      branch: path,
      commit: "abc",
      isMain: false,
      createdAt: null,
    });
    useProjectStore.setState({ projects: [project] });
    useWorktreeStore
      .getState()
      .applyEnrichedProjects([
        { ...project, worktrees: [entry("/repo/.worktrees/a"), entry("/repo/.worktrees/b")] },
      ]);
    const root = worktreeRef(server, "/repo");
    const a = worktreeRef(server, "/repo/.worktrees/a");
    const b = worktreeRef(server, "/repo/.worktrees/b");
    useWorktreeStore.setState(activeWorktreeFields(root));

    const { switchWorktree } = useWorktreeStore.getState();
    await switchWorktree(a);
    await switchWorktree(b);
    goBackWorktree();
    expect(useWorktreeStore.getState().activeWorktree).toEqual(a);
    goBackWorktree();
    expect(useWorktreeStore.getState().activeWorktree).toEqual(root);
    goForwardWorktree();
    expect(useWorktreeStore.getState().activeWorktree).toEqual(a);

    // `b` goes away: going forward finds nothing left to go to.
    useWorktreeStore
      .getState()
      .applyEnrichedProjects([{ ...project, worktrees: [entry("/repo/.worktrees/a")] }]);
    goForwardWorktree();
    expect(useWorktreeStore.getState().activeWorktree).toEqual(a);
  });
});
