import { useMemo } from "react";

import type { WorktreeRef } from "@/api/worktree-ref";
import { projectOf, projectRef, useProjectStore } from "@/store/projects";
import { useWorktreeStore } from "@/store/worktrees";

export interface QueryScope {
  /** The active worktree's project, by its root; null with Home or while projects load. */
  activeProject: WorktreeRef | null;
  /** Null with Home, which belongs to the window and has no server. */
  activeWorktree: WorktreeRef | null;
}

/** The ref of `wt`'s project: its root on `wt`'s server. Null when no listed project holds it. */
export function projectRefOf(wt: WorktreeRef | null): WorktreeRef | null {
  const project = projectOf(wt, useProjectStore.getState().projects);
  return project ? projectRef(project) : null;
}

/** {@link projectRefOf}, re-rendering when it changes; the same object while it does not. */
export function useProjectRef(wt: WorktreeRef | null): WorktreeRef | null {
  const project = useProjectStore((s) => projectOf(wt, s.projects));
  const server = project?.server;
  const path = project?.path;
  return useMemo(
    () => (server && path !== undefined ? projectRef({ server, path }) : null),
    [server, path],
  );
}

/** Reactive scope for query keys — re-renders when project/worktree changes. */
export function useQueryScope(): QueryScope {
  const activeWorktree = useWorktreeStore((s) => s.activeWorktree);
  const activeProject = useProjectRef(activeWorktree);
  return { activeProject, activeWorktree };
}

/** Read scope synchronously (for event handlers, outside React). */
export function getQueryScope(): QueryScope {
  const { activeWorktree } = useWorktreeStore.getState();
  return { activeProject: projectRefOf(activeWorktree), activeWorktree };
}
