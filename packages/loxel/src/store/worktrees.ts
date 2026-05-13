import { create } from "zustand";
import { createJSONStorage, persist, subscribeWithSelector } from "zustand/middleware";

import type { AddWorktreePlan, RemoveWorktreePlan } from "@/api/client";
import type { WorktreeEntry } from "@/api/git-models";
import type { EnrichedProject } from "@/api/project-model";

import * as api from "@/api/client";
import { wsClient } from "@/api/client";
import { STORAGE_PREFIX } from "@/lib/env";
import { toggleSet } from "@/lib/set-utils";

import { deriveProject, useProjectStore } from "./projects";
import { serverWorktreesStorage } from "./server-storage";
import { purgeWorktreeCache, transitionWorktreeState } from "./worktree-cache";
import { purgeWorktreeStores, setActiveWorktreeKey } from "./worktree-store";

const ACTIVE_WT_SESSION_KEY = `${STORAGE_PREFIX}-activeWorktreePath`;

// ── Helpers ──────────────────────────────────────────────────────────────

/** Sort worktrees by creation time ascending (old→new), nulls last. */
function sortByCreatedAt(a: WorktreeEntry, b: WorktreeEntry): number {
  if (!a.createdAt && !b.createdAt) return 0;
  if (!a.createdAt) return 1;
  if (!b.createdAt) return -1;
  return a.createdAt.localeCompare(b.createdAt);
}

/**
 * Sort worktrees for display.
 * Uses custom order if set, otherwise creation time (old→new).
 * New worktrees not in the custom order appear last, sorted by creation time.
 */
export function getOrderedWorktrees(
  worktrees: WorktreeEntry[],
  customOrder: string[] | undefined,
): WorktreeEntry[] {
  if (!customOrder) {
    return [...worktrees].sort(sortByCreatedAt);
  }
  const orderIndex = new Map(customOrder.map((p, i) => [p, i]));
  return [...worktrees].sort((a, b) => {
    const ai = orderIndex.get(a.path);
    const bi = orderIndex.get(b.path);
    if (ai === undefined && bi === undefined) return sortByCreatedAt(a, b);
    if (ai === undefined) return 1;
    if (bi === undefined) return -1;
    return ai - bi;
  });
}

// ── Per-project state ────────────────────────────────────────────────────

export type ProjectConfig = Pick<
  EnrichedProject,
  "hasWtConfig" | "wtCliAvailable" | "worktreesDir"
>;

export interface ProjectState extends Partial<ProjectConfig> {
  worktrees: WorktreeEntry[];
  /** User-defined worktree display order. Persisted to localStorage. */
  customOrder?: string[];
  /** Worktree paths hidden in collapsed sidebar view. Persisted to localStorage. */
  hiddenPaths?: string[];
}

const EMPTY_PROJECT: ProjectState = { worktrees: [] };

// ── Worktree store ──────────────────────────────────────────────────────

export interface WorktreeState {
  /** All per-project state keyed by project path. */
  byProject: Record<string, ProjectState>;
  activeWorktreePath: string | null;

  /** Pending add plan that needs user resolution (branch conflict). */
  pendingAddPlan: (AddWorktreePlan & { projectPath: string }) | null;
  /** Pending remove plan that needs user confirmation (dirty state). */
  pendingRemovePlan: (RemoveWorktreePlan & { wtPath: string; projectPath: string }) | null;

  /** Flag set by keybinding to trigger the inline create worktree UI. */
  createWorktreeRequested: boolean;

  /** Apply enriched project data (called by project store after fetchProjects). */
  applyEnrichedProjects: (enriched: EnrichedProject[]) => void;

  /** Refresh worktrees for a single project (called by ws-bridge on worktrees_changed). */
  refreshProjectWorktrees: (projectPath: string) => Promise<void>;

  /**
   * Switch to a worktree by absolute path. Server supports multiple concurrent projects,
   * so no project switch is needed — only a single api.switchWorktree() call.
   * All state updates are optimistic (before API calls) to prevent WS race conditions.
   */
  switchWorktree: (path: string) => Promise<void>;

  createWorktree: (
    projectPath: string,
    name: string,
    options?: { branch?: string; branchResolution?: "use-existing" | "delete-and-create" },
  ) => Promise<void>;
  requestRemoveWorktree: (projectPath: string, wt: WorktreeEntry) => Promise<void>;
  confirmRemoveWorktree: (options: { deleteBranch: boolean; force: boolean }) => Promise<void>;
  dismissPendingPlan: () => void;
  confirmCreateWorktree: (branchResolution: "use-existing" | "delete-and-create") => Promise<void>;

  requestCreateWorktree: () => void;
  clearCreateWorktreeRequest: () => void;

  setCustomOrder: (projectPath: string, orderedPaths: string[]) => void;
  toggleVisibility: (projectPath: string, path: string) => void;
  reset: () => void;
}

/** Get the project state entry, falling back to a stable empty default. */
function getProject(state: WorktreeState, projectPath: string): ProjectState {
  return state.byProject[projectPath] ?? EMPTY_PROJECT;
}

/** Return a new byProject with a patched entry for one project. */
function patchProject(
  state: WorktreeState,
  projectPath: string,
  patch: Partial<ProjectState>,
): Record<string, ProjectState> {
  return { ...state.byProject, [projectPath]: { ...getProject(state, projectPath), ...patch } };
}

export const useWorktreeStore = create<WorktreeState>()(
  subscribeWithSelector(
    persist(
      (set, get) => ({
        byProject: {},
        activeWorktreePath: sessionStorage.getItem(ACTIVE_WT_SESSION_KEY),
        pendingAddPlan: null,
        pendingRemovePlan: null,
        createWorktreeRequested: false,

        applyEnrichedProjects: (enriched) => {
          // Derive the active project to initialize activeWorktreePath for non-bare repos
          const currentWtPath = get().activeWorktreePath;
          const allProjects = useProjectStore.getState().projects;
          const project = deriveProject(currentWtPath, allProjects);
          const isBare = project?.isBare ?? false;
          const projectPath = project?.path ?? null;

          // Non-bare repos don't have worktree lists; activeWorktreePath = project root
          const activeWorktreePath =
            !isBare && !currentWtPath && projectPath ? projectPath : currentWtPath;

          set((s) => {
            const byProject: Record<string, ProjectState> = { ...s.byProject };

            for (const p of enriched) {
              const existing = byProject[p.path];
              const validPaths = new Set(p.worktrees.map((wt) => wt.path));
              byProject[p.path] = {
                worktrees: p.worktrees.length > 0 ? p.worktrees : (existing?.worktrees ?? []),
                hasWtConfig: p.hasWtConfig,
                wtCliAvailable: p.wtCliAvailable,
                worktreesDir: p.worktreesDir,
                // Prune stale entries from persisted lists
                customOrder: existing?.customOrder?.filter((x) => validPaths.has(x)),
                hiddenPaths: existing?.hiddenPaths?.filter((x) => validPaths.has(x)),
              };
            }

            return { byProject, activeWorktreePath };
          });

          // Validate: if the hydrated activeWorktreePath no longer exists, fall back
          const finalPath = get().activeWorktreePath;
          if (finalPath) {
            const allPaths = new Set([
              ...enriched.map((p) => p.path),
              ...enriched.flatMap((p) => p.worktrees.map((wt) => wt.path)),
            ]);
            if (!allPaths.has(finalPath)) {
              const first = enriched[0];
              const fallback = first
                ? first.isBare
                  ? (first.worktrees[0]?.path ?? null)
                  : first.path
                : null;
              set({ activeWorktreePath: fallback });
              if (fallback) setActiveWorktreeKey(fallback);
              return;
            }
          }

          if (activeWorktreePath) setActiveWorktreeKey(activeWorktreePath);
        },

        refreshProjectWorktrees: async (projectPath) => {
          const allProjects = useProjectStore.getState().projects;
          const project = allProjects.find((p) => p.path === projectPath);
          if (!project) return;

          const data = await api.getProjectWorktrees(project.id);
          const validPaths = new Set(data.worktrees.map((wt) => wt.path));

          set((s) => {
            const existing = getProject(s, projectPath);
            return {
              byProject: patchProject(s, projectPath, {
                worktrees: data.worktrees,
                customOrder: existing.customOrder?.filter((x) => validPaths.has(x)),
                hiddenPaths: existing.hiddenPaths?.filter((x) => validPaths.has(x)),
              }),
            };
          });
        },

        switchWorktree: async (path) => {
          // 1. Set activeWorktreePath OPTIMISTICALLY (before API calls)
          set({ activeWorktreePath: path });

          // 2. Transition worktree state (sets activeWorktreeKey, clears comments)
          transitionWorktreeState(null, path);

          // 4. No server API call needed — server supports concurrent projects.
          // WebSocket subscription is handled by the subscription lifecycle in App.tsx.
        },

        createWorktree: async (projectPath, name, options) => {
          const hasWtConfig = getProject(get(), projectPath).hasWtConfig ?? false;

          if (hasWtConfig) {
            const plan = await api.planAddWorktree(projectPath, name);

            if (plan.branchConflict) {
              if (plan.branchConflict.kind === "used-by-worktree") {
                throw new Error(
                  `A worktree already exists for branch '${name}' at: ${plan.branchConflict.worktreePath}`,
                );
              }
              set({ pendingAddPlan: { ...plan, projectPath } });
              return;
            }

            addOptimisticEntry(set, projectPath, plan.worktreePath, name, true);

            try {
              await api.createWorktree(projectPath, name, { branch: options?.branch });
            } catch (err) {
              removeOptimisticEntry(set, projectPath, plan.worktreePath);
              throw err;
            }
          } else {
            await api.createWorktree(projectPath, name, { branch: options?.branch });
          }

          await get().refreshProjectWorktrees(projectPath);
        },

        confirmCreateWorktree: async (branchResolution) => {
          const { pendingAddPlan } = get();
          if (!pendingAddPlan) return;

          const { name, worktreePath, projectPath } = pendingAddPlan;
          const hasWtConfig = getProject(get(), projectPath).hasWtConfig ?? false;
          set({ pendingAddPlan: null });

          addOptimisticEntry(set, projectPath, worktreePath, name, hasWtConfig);

          try {
            await api.createWorktree(projectPath, name, { branchResolution });
          } catch (err) {
            removeOptimisticEntry(set, projectPath, worktreePath);
            throw err;
          }

          await get().refreshProjectWorktrees(projectPath);
        },

        requestRemoveWorktree: async (projectPath, wt) => {
          const hasWtConfig = getProject(get(), projectPath).hasWtConfig ?? false;

          if (hasWtConfig) {
            const plan = await api.planRemoveWorktree(projectPath, wt.path);
            set({ pendingRemovePlan: { ...plan, wtPath: wt.path, projectPath } });
          } else {
            optimisticRemove(set, projectPath, wt.path);
            try {
              await api.removeWorktreeByPath(projectPath, wt.path);
            } catch (err) {
              await get().refreshProjectWorktrees(projectPath);
              throw err;
            }
            purgeWorktreeStores(wt.path);
            purgeWorktreeCache(wt.path);
            wsClient.unsubscribeWorktree(wt.path);
            await get().refreshProjectWorktrees(projectPath);
          }
        },

        confirmRemoveWorktree: async ({ deleteBranch, force }) => {
          const { pendingRemovePlan } = get();
          if (!pendingRemovePlan) return;

          const { wtPath, worktreePath, projectPath } = pendingRemovePlan;
          set({ pendingRemovePlan: null });

          optimisticRemove(set, projectPath, worktreePath);

          try {
            await api.removeWorktreeByWtPath(projectPath, wtPath, { deleteBranch, force });
          } catch (err) {
            await get().refreshProjectWorktrees(projectPath);
            throw err;
          }

          purgeWorktreeStores(worktreePath);
          purgeWorktreeCache(worktreePath);
          wsClient.unsubscribeWorktree(worktreePath);
          await get().refreshProjectWorktrees(projectPath);
        },

        dismissPendingPlan: () => {
          set({ pendingAddPlan: null, pendingRemovePlan: null });
        },

        requestCreateWorktree: () => {
          set({ createWorktreeRequested: true });
        },

        clearCreateWorktreeRequest: () => {
          set({ createWorktreeRequested: false });
        },

        setCustomOrder: (projectPath, orderedPaths) => {
          set((s) => ({ byProject: patchProject(s, projectPath, { customOrder: orderedPaths }) }));
        },

        toggleVisibility: (projectPath, wtPath) => {
          set((s) => {
            const current = getProject(s, projectPath).hiddenPaths ?? [];
            return {
              byProject: patchProject(s, projectPath, {
                hiddenPaths: [...toggleSet(new Set(current), wtPath)],
              }),
            };
          });
        },

        reset: () => {
          set({
            byProject: {},
            activeWorktreePath: null,
            pendingAddPlan: null,
            pendingRemovePlan: null,
            createWorktreeRequested: false,
          });
        },
      }),
      {
        name: `${STORAGE_PREFIX}-worktrees`,
        storage: createJSONStorage(() => serverWorktreesStorage),
        partialize: (state) => {
          // Only persist customOrder and hiddenPaths per project
          const persisted: Record<string, { customOrder?: string[]; hiddenPaths?: string[] }> = {};
          for (const [path, ps] of Object.entries(state.byProject)) {
            if (ps.customOrder || ps.hiddenPaths) {
              persisted[path] = {
                ...(ps.customOrder ? { customOrder: ps.customOrder } : {}),
                ...(ps.hiddenPaths ? { hiddenPaths: ps.hiddenPaths } : {}),
              };
            }
          }
          return { byProject: persisted };
        },
        merge: (persisted, current) => {
          const p = persisted as { byProject?: Record<string, Partial<ProjectState>> };
          if (!p.byProject || typeof p.byProject !== "object") return current;

          // Merge persisted customOrder/hiddenPaths into current state
          const byProject = { ...current.byProject };
          for (const [path, saved] of Object.entries(p.byProject)) {
            if (!saved || typeof saved !== "object") continue;
            const existing = byProject[path] ?? { worktrees: [] };
            byProject[path] = {
              ...existing,
              ...(Array.isArray(saved.customOrder) ? { customOrder: saved.customOrder } : {}),
              ...(Array.isArray(saved.hiddenPaths) ? { hiddenPaths: saved.hiddenPaths } : {}),
            };
          }
          return { ...current, byProject };
        },
      },
    ),
  ),
);

useWorktreeStore.subscribe(
  (s) => s.activeWorktreePath,
  (path) => {
    if (path) {
      sessionStorage.setItem(ACTIVE_WT_SESSION_KEY, path);
    } else {
      sessionStorage.removeItem(ACTIVE_WT_SESSION_KEY);
    }
  },
);

// ── Optimistic update helpers ──────────────────────────────────────────

type SetFn = (
  fn: WorktreeState | Partial<WorktreeState> | ((state: WorktreeState) => Partial<WorktreeState>),
) => void;

function addOptimisticEntry(
  set: SetFn,
  projectPath: string,
  worktreePath: string,
  name: string,
  hasWtConfig: boolean,
): void {
  const optimistic: WorktreeEntry = {
    path: worktreePath,
    branch: name,
    commit: "",
    isMain: false,
    createdAt: new Date().toISOString(),
    wtName: hasWtConfig ? name : undefined,
    pending: true,
  };
  set((s) => ({
    byProject: patchProject(s, projectPath, {
      worktrees: [...getProject(s, projectPath).worktrees, optimistic],
    }),
  }));
}

function removeOptimisticEntry(set: SetFn, projectPath: string, worktreePath: string): void {
  set((s) => ({
    byProject: patchProject(s, projectPath, {
      worktrees: getProject(s, projectPath).worktrees.filter((wt) => wt.path !== worktreePath),
    }),
  }));
}

function optimisticRemove(set: SetFn, projectPath: string, wtPath: string): void {
  set((s) => {
    const ps = getProject(s, projectPath);
    return {
      byProject: patchProject(s, projectPath, {
        worktrees: ps.worktrees.filter((wt) => wt.path !== wtPath),
        customOrder: ps.customOrder?.filter((p) => p !== wtPath),
        hiddenPaths: ps.hiddenPaths?.filter((p) => p !== wtPath),
      }),
    };
  });
}
