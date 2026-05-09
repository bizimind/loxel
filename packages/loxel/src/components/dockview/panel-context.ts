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
