import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import type { Project } from "@/api/project-model";

import * as api from "@/api/client";
import { STORAGE_PREFIX } from "@/lib/env";
import { toggleSet } from "@/lib/set-utils";

import { serverProjectsStorage } from "./server-storage";

/**
 * Derive the active project from a worktree path using longest-prefix match.
 * For non-bare repos, wtPath === project.path (exact match).
 * For bare repos, wtPath starts with project.path + '/'.
 */
export function deriveProject(wtPath: string | null, projects: Project[]): Project | null {
  if (!wtPath) return null;
  return (
    projects
      .filter((p) => wtPath === p.path || wtPath.startsWith(p.path + "/"))
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
      await wtStore.switchWorktree(target.path);
    } else {
      wtStore.reset();
    }
  }
}

// --- Project store ---

interface ProjectState {
  projects: Project[];
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
        set({
          projects: data.projects.map((p) => ({
            id: p.id,
            path: p.path,
            name: p.name,
            addedAt: p.addedAt,
            isBare: p.isBare,
          })),
        });
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
        await useWorktreeStore.getState().switchWorktree(project.path);
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
