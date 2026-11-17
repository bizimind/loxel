import { useMemo } from "react";

import { localRef } from "@/api/local-server";
import { type WorktreeRef, worktreeRef } from "@/api/worktree-ref";
import { deriveProject, useProjectStore } from "@/store/projects";
import { useWorktreeStore } from "@/store/worktrees";

export interface QueryScope {
  /** The active worktree's project, by its root; null with Home or while projects load. */
  activeProject: WorktreeRef | null;
  /** Null with Home, which belongs to the window and has no server. */
  activeWorktree: WorktreeRef | null;
}

/** The ref of `wt`'s project: its root on `wt`'s server. Null when no listed project holds it. */
export function projectRefOf(wt: WorktreeRef | null): WorktreeRef | null {
  if (!wt) return null;
  const project = deriveProject(wt.path, useProjectStore.getState().projects);
  return project ? worktreeRef(wt.server, project.path) : null;
}

/** {@link projectRefOf}, re-rendering when it changes; the same object while it does not. */
export function useProjectRef(wt: WorktreeRef | null): WorktreeRef | null {
  const projectPath = useProjectStore((s) =>
    wt ? (deriveProject(wt.path, s.projects)?.path ?? null) : null,
  );
  const server = wt?.server;
  return useMemo(
    () => (server && projectPath !== null ? worktreeRef(server, projectPath) : null),
    [server, projectPath],
  );
}

/** Reactive scope for query keys — re-renders when project/worktree changes. */
export function useQueryScope(): QueryScope {
  const activeWorktreePath = useWorktreeStore((s) => s.activeWorktreePath);
  const activeWorktree = useMemo(() => localRef(activeWorktreePath), [activeWorktreePath]);
  const activeProject = useProjectRef(activeWorktree);
  return { activeProject, activeWorktree };
}

/** Read scope synchronously (for event handlers, outside React). */
export function getQueryScope(): QueryScope {
  const activeWorktree = localRef(useWorktreeStore.getState().activeWorktreePath);
  return { activeProject: projectRefOf(activeWorktree), activeWorktree };
}
