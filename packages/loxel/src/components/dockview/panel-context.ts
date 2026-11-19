import type { IDockviewPanel } from "dockview-react";
import { createContext, createElement, type ReactNode, useContext, useMemo } from "react";

import { type ServerId, type WorktreeRef, worktreeRef } from "@/api/worktree-ref";
import { layoutServer } from "@/store/active-worktree";
import { getCenterApiLayoutKey } from "@/store/tools-bar";

interface PanelContextValue {
  /** The worktree the panel was created for; null for Home's panels. */
  worktree: WorktreeRef | null;
}

/** Provides panel-scoped metadata (the panel's worktree) to child components and hooks. */
export const PanelContext = createContext<PanelContextValue>({ worktree: null });

/**
 * The server of the layout a panel is in (see `layoutServer`), which `PersistedLayoutComponent`
 * provides to its panels and tabs: a layout is stored on that server, and its panels' bare
 * `worktreePath` params name worktrees there.
 */
export const LayoutServerContext = createContext<ServerId | null>(null);

/**
 * The server of the layout the calling panel or tab is in, which holds the files of all its panels:
 * a tab header is outside its panel's context, but in its layout.
 */
export function useLayoutServer(): ServerId {
  const server = useContext(LayoutServerContext);
  if (server === null) throw outsideLayout();
  return server;
}

function outsideLayout(): Error {
  return new Error("Panels render inside a layout, which names their server");
}

/** The worktree of a panel's persisted `worktreePath` param, on the server of its layout. */
function panelWorktreeRef(
  server: ServerId,
  worktreePath: string | null | undefined,
): WorktreeRef | null {
  return worktreePath ? worktreeRef(server, worktreePath) : null;
}

/** Provide a panel's worktree from its persisted `worktreePath` param, on its layout's server. */
export function PanelWorktreeProvider({
  worktreePath,
  children,
}: {
  worktreePath: string | null | undefined;
  children: ReactNode;
}) {
  const server = useLayoutServer();
  const value = useMemo(
    () => ({ worktree: panelWorktreeRef(server, worktreePath) }),
    [server, worktreePath],
  );
  return createElement(PanelContext.Provider, { value }, children);
}

/** The panel's worktree (set by the panel wrapper in panels.tsx); null in Home. */
export function usePanelWorktree(): WorktreeRef | null {
  return useContext(PanelContext).worktree;
}

/** The panel's worktree path, for the server API, which takes bare paths. */
export function usePanelWorktreePath(): string | null {
  return usePanelWorktree()?.path ?? null;
}

/** The server holding the panel's files: its worktree's, or its layout's for Home's panels. */
export function usePanelServer(): ServerId {
  const worktree = usePanelWorktree();
  const layout = useContext(LayoutServerContext);
  if (worktree) return worktree.server;
  if (layout === null) throw outsideLayout();
  return layout;
}

/**
 * The server of the center layout, the only one whose panels code outside React looks up (its
 * worktree's, or the window's for Home's). Throws while no center is mounted.
 */
export function centerLayoutServer(): ServerId {
  const layoutKey = getCenterApiLayoutKey();
  if (layoutKey === null) throw new Error("No center layout is mounted");
  return layoutServer(layoutKey);
}

/** The worktree a panel of the center layout was created for (its `worktreePath` param), outside React. */
export function getPanelWorktree(panel: IDockviewPanel): WorktreeRef | null {
  const params: unknown = panel.params;
  if (typeof params !== "object" || params === null || !("worktreePath" in params)) return null;
  const { worktreePath } = params as Record<string, unknown>;
  return typeof worktreePath === "string"
    ? panelWorktreeRef(centerLayoutServer(), worktreePath)
    : null;
}

/** The server holding the files of a panel of the center layout (see `usePanelServer`), outside React. */
export function getPanelServer(panel: IDockviewPanel): ServerId {
  return getPanelWorktree(panel)?.server ?? centerLayoutServer();
}
