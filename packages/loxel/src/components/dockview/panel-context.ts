import type { IDockviewPanel } from "dockview-react";
import { createContext, useContext } from "react";

interface PanelContextValue {
  /** Worktree path captured when the panel was created. */
  worktreePath: string | null;
}

/** Provides panel-scoped metadata (e.g. worktree path) to child components and hooks. */
export const PanelContext = createContext<PanelContextValue>({ worktreePath: null });

/** Read the panel-scoped worktree path (set by the panel wrapper in panels.tsx). */
export function usePanelWorktreePath(): string | null {
  return useContext(PanelContext).worktreePath;
}

/** The worktree path a panel was created for (its `worktreePath` param), outside React. */
export function getPanelWorktreePath(panel: IDockviewPanel): string | null {
  const params: unknown = panel.params;
  if (typeof params !== "object" || params === null || !("worktreePath" in params)) return null;
  const { worktreePath } = params as Record<string, unknown>;
  return typeof worktreePath === "string" ? worktreePath : null;
}
