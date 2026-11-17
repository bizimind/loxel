import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import * as api from "@/api/client";
import { localServerId } from "@/api/local-server";
import type { EnrichedProject, Project } from "@/api/project-model";
import {
  type ServerId,
  type WorktreeRef,
  formatWorktreeRef,
  sameWorktreeRef,
  worktreeRef,
} from "@/api/worktree-ref";
import { STORAGE_PREFIX } from "@/lib/env";
import { dispatchLoxelEvent } from "@/lib/loxel-events";
import { toggleSet } from "@/lib/set-utils";

import { serverProjectsStorage } from "./server-storage";

/** A project as the window lists it: with the server that listed it, which holds its worktrees. */
export interface ListedProject extends EnrichedProject {
  server: ServerId;
}

/** A project's ref: its root on its server. */
export function projectRef(project: Pick<ListedProject, "server" | "path">): WorktreeRef {
  return worktreeRef(project.server, project.path);
}

/**
 * Derive the project holding a path. Explicit worktree membership handles WT_DIR locations
 * outside the repository; the boundary-aware prefix remains a fallback for paths inside bare
 * repositories.
 */
export function deriveProject<P extends EnrichedProject>(
  wtPath: string | null,
  projects: readonly P[],
): P | null {
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

/** The project holding the worktree (or root checkout) `wt`: {@link deriveProject} on its server. */
export function projectOf<P extends ListedProject>(
  wt: WorktreeRef | null,
  projects: readonly P[],
): P | null {
  if (!wt) return null;
  return deriveProject(
    wt.path,
    projects.filter((project) => project.server === wt.server),
  );
}

/** `discarded`: the project's files are deleted, not only removed from Loxel. */
async function removeAndSwitchProject(
  id: string,
  get: () => ProjectState,
  apiCall: () => Promise<unknown>,
  discarded: boolean,
): Promise<void> {
  const { useWorktreeStore } = await import("./worktrees");
  const wtStore = useWorktreeStore.getState();
  const removed = get().projects.find((project) => project.id === id);
  const activeProject = projectOf(wtStore.activeWorktree, get().projects);
  const isRemovingActive =
    removed !== undefined &&
    activeProject !== null &&
    sameWorktreeRef(projectRef(activeProject), projectRef(removed));
  const removedPaths = removed
    ? [
        ...(removed.isBare ? [] : [removed.path]),
        ...(
          wtStore.byProject[formatWorktreeRef(projectRef(removed))]?.worktrees ?? removed.worktrees
        ).map((wt) => wt.path),
      ]
    : [];

  await apiCall();
  for (const wtPath of removedPaths) {
    dispatchLoxelEvent("loxel-worktree-gone", { wtPath, discarded });
  }
  await get().fetchProjects();

  if (isRemovingActive) {
    const remaining = get().projects;
    if (remaining.length > 0) {
      const target = remaining[0]!;
      const targetPath = target.isBare ? target.worktrees[0]?.path : target.path;
      if (targetPath) await wtStore.switchWorktree(worktreeRef(target.server, targetPath));
      else wtStore.reset();
    } else {
      wtStore.reset();
    }
  }
}

const projectsLoaded = Promise.withResolvers<void>();

/**
 * Resolves once the project list and its worktrees have first been fetched (or that fetch failed) —
 * before that, path lookups find no project and no worktree is active (e.g. a file opened while
 * Loxel launches).
 */
export function whenProjectsLoaded(): Promise<void> {
  return projectsLoaded.promise;
}

// --- Project store ---

export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 560;
export const SIDEBAR_DEFAULT_WIDTH = 240;

/** Clamp an expanded-sidebar width to the allowed range; non-finite values fall back to the default. */
export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
}

interface ProjectState {
  projects: ListedProject[];
  /** The server user's home directory (null until projects are first fetched). */
  homeDir: string | null;
  /** Where Home's drafts are kept (`ProjectsResponse.homeDraftsDir`). */
  homeDraftsDir: string | null;
  sidebarExpanded: boolean;
  /** Width of the sidebar when expanded (the collapsed width is fixed). */
  sidebarWidth: number;

  /** Per-project sidebar expand/collapse state (bare repos show worktrees when expanded). */
  expandedProjectIds: string[];
  /**
   * Projects the sidebar has auto-expanded once. Persisted alongside expandedProjectIds so a
   * user's later collapse is not undone by a remount or the next fetch.
   */
  autoExpandedProjectIds: string[];

  /** Whether the first project list fetch has settled, so an empty `projects` means none. */
  projectsFetched: boolean;
  fetchProjects: () => Promise<void>;
  /** Refresh the list after the server added `project`, and switch to it. */
  showAddedProject: (project: Project) => Promise<void>;
  removeProject: (id: string) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  updateProject: (id: string, updates: { name?: string }) => Promise<void>;
  toggleSidebar: () => void;
  setSidebarWidth: (width: number) => void;
  toggleProjectExpanded: (projectId: string) => void;
  /** Record that these projects have had their one-time auto-expand. */
  markAutoExpanded: (projectIds: string[]) => void;
}

export const useProjectStore = create<ProjectState>()(
  persist(
    (set, get) => ({
      projects: [],
      homeDir: null,
      homeDraftsDir: null,
      sidebarExpanded: false,
      sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
      expandedProjectIds: [],
      autoExpandedProjectIds: [],
      projectsFetched: false,

      fetchProjects: async () => {
        try {
          const data = await api.getProjects();
          // Listed by the window's own server, the one connection it has today.
          const server = localServerId();
          set({
            projects: data.projects.map((project) => ({ ...project, server })),
            homeDir: data.homeDir,
            homeDraftsDir: data.homeDraftsDir,
          });
          // Update the worktree store with enriched data
          const { useWorktreeStore } = await import("./worktrees");
          useWorktreeStore.getState().applyEnrichedProjects(get().projects);
        } finally {
          // Settle even on failure, so waiting opens report "no project" instead of hanging
          projectsLoaded.resolve();
          if (!get().projectsFetched) set({ projectsFetched: true });
        }
      },

      showAddedProject: async (project) => {
        // Fetch updated project list so deriveProject() works
        await get().fetchProjects();
        // The server initialized the project when it added it (started its watcher).
        // Switch to the new project's worktree (or project root for non-bare).
        const { useWorktreeStore } = await import("./worktrees");
        const added = get().projects.find((candidate) => candidate.id === project.id);
        if (!added) return;
        const targetPath = added.isBare ? added.worktrees[0]?.path : added.path;
        if (targetPath) {
          await useWorktreeStore.getState().switchWorktree(worktreeRef(added.server, targetPath));
        }
      },

      removeProject: async (id) => {
        await removeAndSwitchProject(id, get, () => api.removeProject(id), false);
      },

      deleteProject: async (id) => {
        await removeAndSwitchProject(id, get, () => api.deleteProject(id), true);
      },

      updateProject: async (id, updates) => {
        await api.updateProject(id, updates);
        await get().fetchProjects();
      },

      toggleSidebar: () => set((s) => ({ sidebarExpanded: !s.sidebarExpanded })),

      setSidebarWidth: (width) => set({ sidebarWidth: clampSidebarWidth(width) }),

      toggleProjectExpanded: (projectId) =>
        set((s) => ({
          expandedProjectIds: [...toggleSet(new Set(s.expandedProjectIds), projectId)],
        })),

      markAutoExpanded: (projectIds) =>
        set((s) => {
          const next = new Set(s.autoExpandedProjectIds);
          for (const id of projectIds) next.add(id);
          return next.size === s.autoExpandedProjectIds.length
            ? {}
            : { autoExpandedProjectIds: [...next] };
        }),
    }),
    {
      name: `${STORAGE_PREFIX}-projects`,
      storage: createJSONStorage(() => serverProjectsStorage),
      partialize: (state) => ({
        sidebarExpanded: state.sidebarExpanded,
        sidebarWidth: state.sidebarWidth,
        expandedProjectIds: state.expandedProjectIds,
        autoExpandedProjectIds: state.autoExpandedProjectIds,
      }),
    },
  ),
);
