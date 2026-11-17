import { afterEach, describe, expect, test } from "bun:test";

import { act, renderHook } from "@testing-library/react";

import { localRef, localServerId } from "@/api/local-server";
import { toServerId, worktreeRef } from "@/api/worktree-ref";

import {
  getWorktreeInnerLayout,
  purgeWorktreeCache,
  registerLayoutCache,
  setWorktreeInnerLayout,
} from "./worktree-cache";
import { createWorktreeStore, purgeWorktreeStores } from "./worktree-store";
import { useWorktreeStore } from "./worktrees";

const PATH = "/repo";
const HERE = localRef(PATH);
/** The same path on another server. */
const THERE = worktreeRef(toServerId("other-server"), PATH);

const counter = createWorktreeStore<{ count: number }>(() => ({ count: 0 }));

afterEach(() => {
  for (const wt of [HERE, THERE]) {
    purgeWorktreeStores(wt);
    purgeWorktreeCache(wt);
  }
  useWorktreeStore.setState({ activeWorktreePath: null });
});

describe("per-worktree store instances", () => {
  test("are kept apart for the same path on two servers", () => {
    counter.getStore(HERE).setState({ count: 1 });
    counter.getStore(THERE).setState({ count: 2 });

    expect(counter.getStore(HERE).getState().count).toBe(1);
    expect(counter.getStore(THERE).getState().count).toBe(2);
    // An equal ref built elsewhere finds the same instance.
    expect(counter.getStore(worktreeRef(localServerId(), PATH))).toBe(counter.getStore(HERE));
  });

  test("hook and imperative access both follow the active worktree", () => {
    counter.getStore(HERE).setState({ count: 5 });
    const { result } = renderHook(() => counter.useStore((s) => s.count));
    expect(result.current).toBe(0); // the no-op store, with nothing active

    act(() => useWorktreeStore.setState({ activeWorktreePath: PATH }));
    expect(result.current).toBe(5);
    expect(counter.getCurrent()).toBe(counter.getStore(HERE));
  });

  test("Home has its own instance, apart from every worktree's", () => {
    counter.getStore(null).setState({ count: 3 });
    expect(counter.getStore(HERE).getState().count).toBe(0);
    expect(counter.getStore(null).getState().count).toBe(3);
  });

  test("are purged by ref, leaving the same path on another server", () => {
    const here = counter.getStore(HERE);
    const there = counter.getStore(THERE);

    purgeWorktreeStores(HERE);

    expect(counter.getStore(HERE)).not.toBe(here);
    expect(counter.getStore(THERE)).toBe(there);
  });
});

describe("per-worktree cache", () => {
  test("is purged by ref, leaving the same path on another server", () => {
    act(() => useWorktreeStore.setState({ activeWorktreePath: PATH }));
    setWorktreeInnerLayout("graph", { grid: {} } as never);
    expect(getWorktreeInnerLayout("graph")).toBeDefined();

    purgeWorktreeCache(THERE);
    expect(getWorktreeInnerLayout("graph")).toBeDefined();
    purgeWorktreeCache(HERE);
    expect(getWorktreeInnerLayout("graph")).toBeUndefined();
  });

  test("purges a layout cache only for a worktree of the server its layouts are stored on", () => {
    const cache = new Map<string, unknown>([[PATH, {}]]);
    const unregister = registerLayoutCache(localServerId(), cache);

    purgeWorktreeCache(THERE);
    expect(cache.has(PATH)).toBe(true);
    purgeWorktreeCache(HERE);
    expect(cache.has(PATH)).toBe(false);
    unregister();
  });
});
