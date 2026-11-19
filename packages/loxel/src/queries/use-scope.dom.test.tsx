import { afterEach, describe, expect, test } from "bun:test";

import { act, renderHook } from "@testing-library/react";

import { localRef } from "@/api/local-server";
import { useProjectStore } from "@/store/projects";
import { activeWorktreeFields, useWorktreeStore } from "@/store/worktrees";

import { useShownWorktree } from "./use-scope";

afterEach(() => {
  useProjectStore.setState({ projectsFetched: false });
  useWorktreeStore.setState(activeWorktreeFields(null));
});

describe("useShownWorktree", () => {
  test("holds a restored worktree back until the project list is in, so no key lacks its project", () => {
    useWorktreeStore.setState(activeWorktreeFields(localRef("/repo")));
    const { result } = renderHook(() => useShownWorktree());
    expect(result.current).toBeUndefined();

    act(() => useProjectStore.setState({ projectsFetched: true }));

    expect(result.current).toEqual(localRef("/repo"));
  });

  test("shows Home at once: it has no project to wait for", () => {
    const { result } = renderHook(() => useShownWorktree());
    expect(result.current).toBeNull();
  });
});
