import { deriveProject, useProjectStore } from "@/store/projects";
import { useWorktreeStore } from "@/store/worktrees";

export interface QueryScope {
  activeProjectPath: string | null;
  activeWorktreePath: string | null;
}

/** Reactive scope for query keys — re-renders when project/worktree changes. */
export function useQueryScope(): QueryScope {
  const activeWorktreePath = useWorktreeStore((s) => s.activeWorktreePath);
  const activeProjectPath = useProjectStore(
    (s) => deriveProject(activeWorktreePath, s.projects)?.path ?? null,
  );
  return { activeProjectPath, activeWorktreePath };
}

/** Read scope synchronously (for event handlers, outside React). */
export function getQueryScope(): QueryScope {
  const activeWorktreePath = useWorktreeStore.getState().activeWorktreePath;
  const projects = useProjectStore.getState().projects;
  const activeProjectPath = deriveProject(activeWorktreePath, projects)?.path ?? null;
  return { activeProjectPath, activeWorktreePath };
}
