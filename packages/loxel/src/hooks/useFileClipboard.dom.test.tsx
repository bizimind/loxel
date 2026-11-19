import { afterEach, describe, expect, mock, test } from "bun:test";

import { QueryClient } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";

import { localRef } from "@/api/local-server";
import { toServerId, type WorktreeRef, worktreeRef } from "@/api/worktree-ref";

const copies: Array<{ wt: WorktreeRef; srcPath: string; destDir: string }> = [];
const toasts: string[] = [];
const actualClient = await import("@/api/client");
mock.module("@/api/client", () => ({
  ...actualClient,
  copyProjectFile: async (wt: WorktreeRef, options: { srcPath: string; destDir: string }) => {
    copies.push({ wt, ...options });
    return { newPath: `${options.destDir}/copied` };
  },
}));
mock.module("@/components/ui/toast", () => ({
  showToast: (message: string) => toasts.push(message),
}));

const { activeWorktreeFields, useWorktreeStore } = await import("@/store/worktrees");
const { useFileClipboard } = await import("./useFileClipboard");

const THERE = toServerId("other-server");
const REPO = "/repo";

function renderClipboard() {
  return renderHook(() =>
    useFileClipboard(
      () => false,
      new QueryClient(),
      REPO,
      (path) => (path === REPO || path.startsWith(`${REPO}/`) ? REPO : null),
    ),
  );
}

afterEach(() => {
  copies.length = 0;
  toasts.length = 0;
  useWorktreeStore.setState(activeWorktreeFields(null));
});

describe("useFileClipboard", () => {
  test("pastes on the server the file was copied on", async () => {
    useWorktreeStore.setState(activeWorktreeFields(localRef(REPO)));
    const { result } = renderClipboard();
    act(() => result.current.handleCopyFile("/repo/a.ts"));
    await act(() => result.current.handlePaste("/repo/src"));
    expect(copies).toEqual([{ wt: localRef(REPO), srcPath: "/repo/a.ts", destDir: "/repo/src" }]);
  });

  test("refuses a paste into the same path on another server", async () => {
    useWorktreeStore.setState(activeWorktreeFields(localRef(REPO)));
    const { result } = renderClipboard();
    act(() => result.current.handleCopyFile("/repo/a.ts"));
    act(() => useWorktreeStore.setState(activeWorktreeFields(worktreeRef(THERE, REPO))));
    await act(() => result.current.handlePaste("/repo/src"));
    expect(copies).toEqual([]);
    expect(toasts).toEqual(["Can't move or copy between servers"]);
  });
});
