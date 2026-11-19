import { afterEach, describe, expect, test } from "bun:test";

import { cleanup, renderHook } from "@testing-library/react";
import type { DockviewApi, IDockviewPanel } from "dockview-react";
import type { ReactNode } from "react";

import { localRef, localServerId } from "@/api/local-server";
import { toServerId, worktreeRef } from "@/api/worktree-ref";
import { getActiveEditorFile } from "@/lib/reveal-in-explorer";
import { layoutKeyOf } from "@/store/active-worktree";
import { fileEditorKey } from "@/store/editor-state";
import { setCenterApi } from "@/store/tools-bar";

import {
  getPanelServer,
  getPanelWorktree,
  LayoutServerContext,
  PanelWorktreeProvider,
  usePanelServer,
  usePanelWorktree,
} from "./panel-context";

const PATH = "/repo";
const FILE = `${PATH}/a.ts`;
const OTHER = toServerId("other-server");

const panel = { id: `codeeditor-${FILE}`, params: { filePath: FILE, worktreePath: PATH } };

afterEach(() => {
  cleanup();
  setCenterApi(null);
});

function inLayout(server: typeof OTHER, worktreePath: string | null) {
  return ({ children }: { children: ReactNode }) => (
    <LayoutServerContext.Provider value={server}>
      <PanelWorktreeProvider worktreePath={worktreePath}>{children}</PanelWorktreeProvider>
    </LayoutServerContext.Provider>
  );
}

describe("a panel's worktree", () => {
  test("is its param's path on the server of the layout it is in", () => {
    const here = renderHook(() => usePanelWorktree(), { wrapper: inLayout(localServerId(), PATH) });
    const there = renderHook(() => usePanelWorktree(), { wrapper: inLayout(OTHER, PATH) });
    expect(here.result.current).toEqual(localRef(PATH));
    expect(there.result.current).toEqual(worktreeRef(OTHER, PATH));
  });

  test("of a Home panel is none, and its files are on its layout's server", () => {
    const { result } = renderHook(() => [usePanelWorktree(), usePanelServer()] as const, {
      wrapper: inLayout(OTHER, null),
    });
    expect(result.current).toEqual([null, OTHER]);
  });

  test("outside React is on the server of the center layout", () => {
    const center = { activePanel: panel } as unknown as DockviewApi;
    setCenterApi(center, layoutKeyOf(worktreeRef(OTHER, PATH)));
    const there = panel as unknown as IDockviewPanel;
    expect(getPanelWorktree(there)).toEqual(worktreeRef(OTHER, PATH));
    expect(getPanelServer(there)).toBe(OTHER);
    // The active editor file carries both, so state the tab published is found by its own key.
    expect(getActiveEditorFile()).toEqual({
      filePath: FILE,
      worktree: worktreeRef(OTHER, PATH),
      editorKey: fileEditorKey(OTHER, FILE),
    });

    setCenterApi(center, layoutKeyOf(localRef(PATH)));
    expect(getActiveEditorFile()?.editorKey).toBe(fileEditorKey(localServerId(), FILE));
  });
});
