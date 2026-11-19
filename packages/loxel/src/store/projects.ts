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

/**
 * `projects` with `server`'s replaced by `listed`, in the place its first one had (at the end if it
 * had none), other servers' kept as they are: one server's list says nothing about the others'.
 */
export function withServerProjects(
  projects: readonly ListedProject[],
  server: ServerId,
  listed: readonly ListedProject[],
): ListedProject[] {
  const at = projects.findIndex((project) => project.server === server);
  const others = projects.filter((project) => project.server !== server);
  // Everything before a server's first project is another server's.
  const index = at === -1 ? others.length : at;
  return [...others.slice(0, index), ...listed, ...others.slice(index)];
}

/**
 * The listed project `id` names. Ids are UUIDs each server makes, so one names one project across
 * the window's servers; the request about it goes to its server.
 */
function listedProject(get: () => ProjectState, id: string): ListedProject {
  const project = get().projects.find((candidate) => candidate.id === id);
  if (!project) throw new Error(`No listed project ${id}`);
  return project;
}

/** `discarded`: the project's files are deleted, not only removed from Loxel. */
async function removeAndSwitchProject(
  id: string,
  get: () => ProjectState,
  apiCall: (server: ServerId) => Promise<unknown>,
  discarded: boolean,
): Promise<void> {
  const { useWorktreeStore } = await import("./worktrees");
  const wtStore = useWorktreeStore.getState();
  const removed = listedProject(get, id);
  const activeProject = projectOf(wtStore.activeWorktree, get().projects);
  const isRemovingActive =
    activeProject !== null && sameWorktreeRef(projectRef(activeProject), projectRef(removed));
  const removedWorktrees = [
    ...(removed.isBare ? [] : [removed.path]),
    ...(
      wtStore.byProject[formatWorktreeRef(projectRef(removed))]?.worktrees ?? removed.worktrees
    ).map((wt) => wt.path),
  ].map((path) => worktreeRef(removed.server, path));

  await apiCall(removed.server);
  for (const wt of removedWorktrees) {
    dispatchLoxelEvent("loxel-worktree-gone", { wt, discarded });
  }
  await get().fetchProjects();

  if (isRemovingActive) {
    const remaining = get().projects;
    // A project of the removed one's server first.
    const target = remaining.find((project) => project.server === removed.server) ?? remaining[0];
    if (target) {
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
          // Listed by the window's own server, the one connection it has today.
          const server = localServerId();
          const data = await api.getProjects(server);
          const listed = data.projects.map((project) => ({ ...project, server }));
          set((s) => ({
            projects: withServerProjects(s.projects, server, listed),
            homeDir: data.homeDir,
            homeDraftsDir: data.homeDraftsDir,
          }));
          // Update the worktree store with enriched data
          const { useWorktreeStore } = await import("./worktrees");
          useWorktreeStore.getState().applyEnrichedProjects(server, listed);
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
        // The window's own server added it; switch there even if the list does not show it yet.
        const server = added?.server ?? localServerId();
        const targetPath = added?.isBare ? added.worktrees[0]?.path : project.path;
        if (targetPath) {
          await useWorktreeStore.getState().switchWorktree(worktreeRef(server, targetPath));
        }
      },

      removeProject: async (id) => {
        await removeAndSwitchProject(id, get, (server) => api.removeProject(server, id), false);
      },

      deleteProject: async (id) => {
        await removeAndSwitchProject(id, get, (server) => api.deleteProject(server, id), true);
      },

      updateProject: async (id, updates) => {
        await api.updateProject(listedProject(get, id).server, id, updates);
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
