import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import * as api from "@/api/client";
import type { EnrichedProject, Project } from "@/api/project-model";
import { STORAGE_PREFIX } from "@/lib/env";
import { toggleSet } from "@/lib/set-utils";

import { serverProjectsStorage } from "./server-storage";

/**
 * Derive the active project from a worktree path. Explicit worktree membership
 * handles WT_DIR locations outside the repository; the boundary-aware prefix
 * remains a fallback for paths inside bare repositories.
 */
export function deriveProject(
  wtPath: string | null,
  projects: Array<Project & { worktrees?: EnrichedProject["worktrees"] }>,
): Project | null {
  if (!wtPath) return null;
  return (
    projects
      .filter(
        (p) =>
          wtPath === p.path ||
          p.worktrees?.some((worktree) => worktree.path === wtPath) ||
          wtPath.startsWith(p.path + "/"),
      )
      .sort((a, b) => b.path.length - a.path.length)[0] ?? null
  );
}

async function removeAndSwitchProject(
  id: string,
  get: () => ProjectState,
  apiCall: () => Promise<unknown>,
): Promise<void> {
  const { useWorktreeStore } = await import("./worktrees");
  const wtStore = useWorktreeStore.getState();
  const activeProject = deriveProject(wtStore.activeWorktreePath, get().projects);
  const isRemovingActive = activeProject?.id === id;

  await apiCall();
  await get().fetchProjects();

  if (isRemovingActive) {
    const remaining = get().projects;
    if (remaining.length > 0) {
      const target = remaining[0]!;
      const targetPath = target.isBare ? target.worktrees[0]?.path : target.path;
      if (targetPath) await wtStore.switchWorktree(targetPath);
      else wtStore.reset();
    } else {
      wtStore.reset();
    }
  }
}

// --- Project store ---

interface ProjectState {
  projects: EnrichedProject[];
  sidebarExpanded: boolean;

  /** Per-project sidebar expand/collapse state (bare repos show worktrees when expanded). */
  expandedProjectIds: string[];

  fetchProjects: () => Promise<void>;
  addProject: (path: string, name?: string) => Promise<void>;
  removeProject: (id: string) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  updateProject: (id: string, updates: { name?: string }) => Promise<void>;
  toggleSidebar: () => void;
  toggleProjectExpanded: (projectId: string) => void;
}

export const useProjectStore = create<ProjectState>()(
  persist(
    (set, get) => ({
      projects: [],
      sidebarExpanded: false,
      expandedProjectIds: [],

      fetchProjects: async () => {
        const data = await api.getProjects();
        set({ projects: data.projects });
        // Update the worktree store with enriched data
        const { useWorktreeStore } = await import("./worktrees");
        useWorktreeStore.getState().applyEnrichedProjects(data.projects);
      },

      addProject: async (path, name) => {
        const project = await api.addProject(path, name);
        // Fetch updated project list so deriveProject() works
        await get().fetchProjects();
        // Server initializes the project during addProject (starts watcher).
        // Switch to the new project's worktree (or project root for non-bare).
        const { useWorktreeStore } = await import("./worktrees");
        const added = get().projects.find((candidate) => candidate.id === project.id);
        const targetPath = added?.isBare ? added.worktrees[0]?.path : project.path;
        if (targetPath) await useWorktreeStore.getState().switchWorktree(targetPath);
      },

      removeProject: async (id) => {
        await removeAndSwitchProject(id, get, () => api.removeProject(id));
      },

      deleteProject: async (id) => {
        await removeAndSwitchProject(id, get, () => api.deleteProject(id));
      },

      updateProject: async (id, updates) => {
        await api.updateProject(id, updates);
        await get().fetchProjects();
      },

      toggleSidebar: () => set((s) => ({ sidebarExpanded: !s.sidebarExpanded })),

      toggleProjectExpanded: (projectId) =>
        set((s) => ({
          expandedProjectIds: [...toggleSet(new Set(s.expandedProjectIds), projectId)],
        })),
    }),
    {
      name: `${STORAGE_PREFIX}-projects`,
      storage: createJSONStorage(() => serverProjectsStorage),
      partialize: (state) => ({
        sidebarExpanded: state.sidebarExpanded,
        expandedProjectIds: state.expandedProjectIds,
      }),
    },
  ),
);
