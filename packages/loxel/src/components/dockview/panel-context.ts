import type { IDockviewPanel } from "dockview-react";
import { createContext, createElement, type ReactNode, useContext, useMemo } from "react";

import { localServerId } from "@/api/local-server";
import type { ServerId, WorktreeRef } from "@/api/worktree-ref";
import { layoutWorktreeRef } from "@/store/active-worktree";

interface PanelContextValue {
  /** The worktree the panel was created for; null for Home's panels. */
  worktree: WorktreeRef | null;
}

/** Provides panel-scoped metadata (the panel's worktree) to child components and hooks. */
export const PanelContext = createContext<PanelContextValue>({ worktree: null });

/** The worktree of a panel's persisted `worktreePath` param (see `layoutWorktreeRef`). */
export function panelWorktreeRef(worktreePath: string | null | undefined): WorktreeRef | null {
  return worktreePath ? layoutWorktreeRef(worktreePath) : null;
}

/** Provide a panel's worktree from its persisted `worktreePath` param (see `panelWorktreeRef`). */
export function PanelWorktreeProvider({
  worktreePath,
  children,
}: {
  worktreePath: string | null | undefined;
  children: ReactNode;
}) {
  const value = useMemo(() => ({ worktree: panelWorktreeRef(worktreePath) }), [worktreePath]);
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

/** The server holding the panel's files: its worktree's, or the window's for Home's panels. */
export function usePanelServer(): ServerId {
  return usePanelWorktree()?.server ?? localServerId();
}

/** The worktree a panel was created for (its `worktreePath` param), outside React. */
export function getPanelWorktree(panel: IDockviewPanel): WorktreeRef | null {
  const params: unknown = panel.params;
  if (typeof params !== "object" || params === null || !("worktreePath" in params)) return null;
  const { worktreePath } = params as Record<string, unknown>;
  return typeof worktreePath === "string" ? panelWorktreeRef(worktreePath) : null;
}

/**
 * The server holding the files of a panel whose `worktreePath` param is `worktreePath` (see
 * `usePanelServer`), for a tab header, which is outside the panel's context.
 */
export function panelServerOf(worktreePath: string | null | undefined): ServerId {
  return panelWorktreeRef(worktreePath)?.server ?? localServerId();
}

/** The server holding a panel's files (see `usePanelServer`), outside React. */
export function getPanelServer(panel: IDockviewPanel): ServerId {
  return getPanelWorktree(panel)?.server ?? localServerId();
}
