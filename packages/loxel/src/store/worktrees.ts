import { create } from "zustand";
import { createJSONStorage, persist, subscribeWithSelector } from "zustand/middleware";

import type { AddWorktreePlan, CreateWorktreeOptions } from "@/api/client";
import * as api from "@/api/client";
import { wsClient } from "@/api/client";
import type { WorktreeEntry } from "@/api/git-models";
import type { EnrichedProject } from "@/api/project-model";
import type { NestedRemoval, WorktreeRemovePlan } from "@/api/worktree-removal-model";
import { STORAGE_PREFIX } from "@/lib/env";
import { findTreeRoot } from "@/lib/project-file-helpers";
import { toggleSet } from "@/lib/set-utils";
import { buildWorktreeRows, type WorktreeRow } from "@/lib/worktree-hierarchy";

import { deriveProject, useProjectStore } from "./projects";
import { serverWorktreesStorage } from "./server-storage";
import { purgeWorktreeCache, transitionWorktreeState } from "./worktree-cache";
import { purgeWorktreeStores, setActiveWorktreeKey } from "./worktree-store";

const ACTIVE_WT_SESSION_KEY = `${STORAGE_PREFIX}-activeWorktreePath`;
const refreshRequestIds = new Map<string, number>();
/** Worktrees with a removal request in flight; shown as pending across list refreshes. */
const removingPaths = new Set<string>();
let nextRefreshRequestId = 0;

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

export type ProjectConfig = Pick<EnrichedProject, "worktreesDir" | "worktreeMetadata">;

export interface ProjectState extends Partial<ProjectConfig> {
  worktrees: WorktreeEntry[];
  /** User-defined worktree display order, across all nesting levels. Persisted. */
  customOrder?: string[];
  /** Worktree paths hidden (with everything nested below them) in the collapsed rail. Persisted. */
  hiddenPaths?: string[];
  /** Worktrees whose nested worktrees are folded away in the sidebar. Persisted. */
  collapsedPaths?: string[];
}

const EMPTY_PROJECT: ProjectState = { worktrees: [] };

/** The per-project lists saved through server storage and synced across windows. */
const PERSISTED_KEYS = ["customOrder", "hiddenPaths", "collapsedPaths"] as const;
export type PersistedProjectState = Pick<ProjectState, (typeof PERSISTED_KEYS)[number]>;

/** The persisted lists of every project that has any. */
export function persistedProjectStates(
  byProject: Readonly<Record<string, ProjectState>>,
): Record<string, PersistedProjectState> {
  const persisted: Record<string, PersistedProjectState> = {};
  for (const [path, ps] of Object.entries(byProject)) {
    const saved: PersistedProjectState = {};
    for (const key of PERSISTED_KEYS) if (ps[key]) saved[key] = ps[key];
    if (Object.keys(saved).length > 0) persisted[path] = saved;
  }
  return persisted;
}

/**
 * `byProject` with saved lists (untrusted: from storage or another window) applied over each
 * project's entry, keeping its runtime data (worktree list, etc.).
 */
export function mergePersistedProjectStates(
  byProject: Readonly<Record<string, ProjectState>>,
  saved: unknown,
): Record<string, ProjectState> {
  const merged = { ...byProject };
  if (!saved || typeof saved !== "object") return merged;
  for (const [path, entry] of Object.entries(saved)) {
    if (!entry || typeof entry !== "object") continue;
    const next: ProjectState = { ...(merged[path] ?? { worktrees: [] }) };
    for (const key of PERSISTED_KEYS) {
      const value: unknown = (entry as Record<string, unknown>)[key];
      if (Array.isArray(value)) next[key] = value.filter((x) => typeof x === "string");
    }
    merged[path] = next;
  }
  return merged;
}

/** The persisted lists pruned to worktrees that still exist. */
function prunePersisted(ps: ProjectState | undefined, valid: ReadonlySet<string>) {
  return Object.fromEntries(
    PERSISTED_KEYS.map((key) => [key, ps?.[key]?.filter((path) => valid.has(path))]),
  ) as PersistedProjectState;
}

/** The project's worktrees as the expanded sidebar lists them: nested, collapsed subtrees left out. */
export function getWorktreeRows(ps: ProjectState): WorktreeRow<WorktreeEntry>[] {
  return buildWorktreeRows(
    getOrderedWorktrees(ps.worktrees, ps.customOrder),
    new Set(ps.collapsedPaths),
    new Set(ps.hiddenPaths),
  );
}

/**
 * The worktrees `Ctrl+Alt+1`–`0` number: the sidebar's visible order without hidden subtrees or
 * pending entries, the same whether or not the sidebar is expanded.
 */
export function getNumberedWorktrees(ps: ProjectState): WorktreeEntry[] {
  return getWorktreeRows(ps)
    .filter((row) => !row.hidden && !row.wt.pending)
    .map((row) => row.wt);
}

/**
 * The worktree that contains `path` (the worktree root included): the deepest match among every
 * project's worktrees and non-bare roots. Worktree lists come from `byProject`, which
 * `worktrees_changed` keeps current — unlike the snapshot loaded with the projects. Null when no
 * worktree contains it.
 */
export function deriveOwningWorktree(
  path: string,
  projects: readonly Pick<EnrichedProject, "path" | "isBare" | "worktrees">[],
  byProject: Readonly<Record<string, Pick<ProjectState, "worktrees">>>,
): string | null {
  const roots = projects.flatMap((project) => {
    const worktrees = byProject[project.path]?.worktrees ?? project.worktrees;
    const worktreeRoots = worktrees.map((worktree) => worktree.path);
    return project.isBare ? worktreeRoots : [...worktreeRoots, project.path];
  });
  return findTreeRoot(path, roots);
}

// ── Worktree store ──────────────────────────────────────────────────────

export interface WorktreeState {
  /** All per-project state keyed by project path. */
  byProject: Record<string, ProjectState>;
  activeWorktreePath: string | null;

  /** Pending add plan that needs user resolution (branch conflict). */
  pendingAddPlan: (AddWorktreePlan & { projectPath: string; parentPath?: string }) | null;
  /** Pending remove plan that needs user confirmation (dirty state). */
  pendingRemovePlan: (WorktreeRemovePlan & { wtPath: string; projectPath: string }) | null;

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

  /** Create a worktree; with `parentPath`, a child branched from that worktree's commit. */
  createWorktree: (
    projectPath: string,
    name: string,
    options?: Pick<CreateWorktreeOptions, "branch" | "parentPath">,
  ) => Promise<void>;
  requestRemoveWorktree: (projectPath: string, wt: WorktreeEntry) => Promise<void>;
  confirmRemoveWorktree: (options: {
    deleteBranch: boolean;
    force: boolean;
    nested?: NestedRemoval;
  }) => Promise<void>;
  /** Nest a worktree under another, or move it to the top level (`parentPath: null`). */
  setWorktreeParent: (
    projectPath: string,
    path: string,
    parentPath: string | null,
  ) => Promise<void>;
  /** Show `displayName` instead of the worktree name; empty shows the worktree name again. */
  renameWorktree: (projectPath: string, path: string, displayName: string) => Promise<void>;
  /** Turn on worktree metadata for the project, so its worktrees can nest. */
  enableWorktreeMetadata: (projectPath: string) => Promise<void>;
  dismissPendingPlan: () => void;
  confirmCreateWorktree: (branchResolution: "use-existing" | "delete-and-create") => Promise<void>;

  requestCreateWorktree: () => void;
  clearCreateWorktreeRequest: () => void;

  setCustomOrder: (projectPath: string, orderedPaths: string[]) => void;
  toggleVisibility: (projectPath: string, path: string) => void;
  /** Fold or unfold the worktrees nested below `path`. */
  toggleCollapsed: (projectPath: string, path: string) => void;
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

          // A regular repo's root checkout is a valid context on its own, so a
          // fresh session starts there rather than in a `.worktrees/` entry.
          const activeWorktreePath =
            !isBare && !currentWtPath && projectPath ? projectPath : currentWtPath;

          set((s) => {
            const byProject: Record<string, ProjectState> = { ...s.byProject };

            for (const p of enriched) {
              const existing = byProject[p.path];
              const effectiveWorktrees =
                p.worktrees.length > 0 ? p.worktrees : (existing?.worktrees ?? []);
              const validPaths = new Set(effectiveWorktrees.map((wt) => wt.path));
              byProject[p.path] = {
                worktrees: effectiveWorktrees,
                worktreesDir: p.worktreesDir,
                worktreeMetadata: p.worktreeMetadata,
                ...prunePersisted(existing, validPaths),
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
          const requestId = ++nextRefreshRequestId;
          refreshRequestIds.set(projectPath, requestId);
          const allProjects = useProjectStore.getState().projects;
          const project = allProjects.find((p) => p.path === projectPath);
          if (!project) return;
          const priorPaths = new Set(getProject(get(), projectPath).worktrees.map((wt) => wt.path));

          const data = await api.getProjectWorktrees(project.id);
          if (refreshRequestIds.get(projectPath) !== requestId) return;
          const validPaths = new Set([
            ...data.worktrees.map((wt) => wt.path),
            ...(project.isBare ? [] : [project.path]),
          ]);

          set((s) => {
            const existing = getProject(s, projectPath);
            return {
              byProject: patchProject(s, projectPath, {
                worktrees: data.worktrees.map((wt) =>
                  removingPaths.has(wt.path) ? { ...wt, pending: "removing" as const } : wt,
                ),
                worktreeMetadata: data.worktreeMetadata,
                ...prunePersisted(existing, validPaths),
              }),
            };
          });

          const active = get().activeWorktreePath;
          const activeProject = deriveProject(active, allProjects);
          const belongedToProject =
            active === project.path ||
            priorPaths.has(active ?? "") ||
            activeProject?.id === project.id;
          if (!active || !belongedToProject || validPaths.has(active)) return;

          purgeWorktreeStores(active);
          purgeWorktreeCache(active);
          wsClient.unsubscribeWorktree(active);

          const fallback = project.isBare ? (data.worktrees[0]?.path ?? null) : project.path;
          set({ activeWorktreePath: fallback });
          if (fallback) transitionWorktreeState(active, fallback);
          else setActiveWorktreeKey("");
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
          const plan = await api.planAddWorktree(projectPath, name);
          const parentPath = options?.parentPath;

          if (plan.branchConflict) {
            if (plan.branchConflict.kind === "used-by-worktree") {
              throw new Error(
                `A worktree already exists for branch '${plan.branch}' at: ${plan.branchConflict.worktreePath}`,
              );
            }
            set({ pendingAddPlan: { ...plan, projectPath, parentPath } });
            return;
          }

          addOptimisticEntry(set, projectPath, plan.worktreePath, name, parentPath);

          try {
            await api.createWorktree(projectPath, name, { branch: options?.branch, parentPath });
          } catch (err) {
            removeOptimisticEntry(set, projectPath, plan.worktreePath);
            throw err;
          }

          await get().refreshProjectWorktrees(projectPath);
        },

        confirmCreateWorktree: async (branchResolution) => {
          const { pendingAddPlan } = get();
          if (!pendingAddPlan) return;

          const { name, worktreePath, projectPath, parentPath } = pendingAddPlan;
          set({ pendingAddPlan: null });

          addOptimisticEntry(set, projectPath, worktreePath, name, parentPath);

          try {
            await api.createWorktree(projectPath, name, { branchResolution, parentPath });
          } catch (err) {
            removeOptimisticEntry(set, projectPath, worktreePath);
            throw err;
          }

          await get().refreshProjectWorktrees(projectPath);
        },

        requestRemoveWorktree: async (projectPath, wt) => {
          const plan = await api.planRemoveWorktree(projectPath, wt.path);
          set({ pendingRemovePlan: { ...plan, wtPath: wt.path, projectPath } });
        },

        confirmRemoveWorktree: async ({ deleteBranch, force, nested = "move-up" }) => {
          const { pendingRemovePlan } = get();
          if (!pendingRemovePlan) return;

          const { wtPath, worktreePath, projectPath } = pendingRemovePlan;
          set({ pendingRemovePlan: null });
          const removed = [
            worktreePath,
            ...(nested === "remove" ? pendingRemovePlan.nested.map((wt) => wt.path) : []),
          ];

          // Not removed optimistically: the entries stay, marked pending, until the server has
          // unregistered the worktrees (their files are deleted afterwards, in the background).
          for (const path of removed) {
            removingPaths.add(path);
            markRemoving(set, projectPath, path);
          }
          let result: Awaited<ReturnType<typeof api.removeWorktreeByWtPath>>;
          try {
            result = await api.removeWorktreeByWtPath(projectPath, wtPath, {
              deleteBranch,
              force,
              nested,
            });
          } catch (err) {
            for (const path of removed) removingPaths.delete(path);
            await get().refreshProjectWorktrees(projectPath);
            throw err;
          }
          for (const path of removed) {
            removingPaths.delete(path);
            purgeWorktreeStores(path);
            purgeWorktreeCache(path);
            wsClient.unsubscribeWorktree(path);
          }
          await get().refreshProjectWorktrees(projectPath);

          if (deleteBranch && !result.branchDeleted) {
            throw new Error(
              "The worktree was removed, but its branch could not be deleted. The branch was kept.",
            );
          }
        },

        setWorktreeParent: async (projectPath, path, parentPath) => {
          const parent = parentPath
            ? getProject(get(), projectPath).worktrees.find((wt) => wt.path === parentPath)
            : undefined;
          // Show the move at once when the parent already has an id; the refresh confirms it.
          if (parentPath === null || parent?.wtId) {
            patchEntry(set, projectPath, path, { parentWtId: parent?.wtId });
          }
          if (parentPath) expand(set, projectPath, parentPath);
          try {
            await api.updateWorktreeMeta(projectPath, path, { parentPath });
          } finally {
            await get().refreshProjectWorktrees(projectPath);
          }
        },

        renameWorktree: async (projectPath, path, displayName) => {
          const trimmed = displayName.trim();
          patchEntry(set, projectPath, path, { displayName: trimmed || undefined });
          try {
            await api.updateWorktreeMeta(projectPath, path, { displayName: trimmed || null });
          } finally {
            await get().refreshProjectWorktrees(projectPath);
          }
        },

        enableWorktreeMetadata: async (projectPath) => {
          await api.enableWorktreeMetadata(projectPath);
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

        toggleCollapsed: (projectPath, wtPath) => {
          set((s) => {
            const current = getProject(s, projectPath).collapsedPaths ?? [];
            return {
              byProject: patchProject(s, projectPath, {
                collapsedPaths: [...toggleSet(new Set(current), wtPath)],
              }),
            };
          });
        },

        reset: () => {
          refreshRequestIds.clear();
          removingPaths.clear();
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
        partialize: (state) => ({ byProject: persistedProjectStates(state.byProject) }),
        merge: (persisted, current) => {
          if (!persisted || typeof persisted !== "object" || !("byProject" in persisted)) {
            return current;
          }
          return {
            ...current,
            byProject: mergePersistedProjectStates(current.byProject, persisted.byProject),
          };
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
  parentPath: string | undefined,
): void {
  const project = useWorktreeStore.getState().byProject[projectPath];
  const parentWtId = parentPath
    ? project?.worktrees.find((wt) => wt.path === parentPath)?.wtId
    : undefined;
  const optimistic: WorktreeEntry = {
    path: worktreePath,
    branch: name,
    commit: "",
    isMain: false,
    createdAt: new Date().toISOString(),
    wtName: name,
    ...(parentWtId ? { parentWtId } : {}),
    pending: "creating",
  };
  if (parentPath) expand(set, projectPath, parentPath);
  set((s) => ({
    byProject: patchProject(s, projectPath, {
      worktrees: [...getProject(s, projectPath).worktrees, optimistic],
    }),
  }));
}

/** Unfold `path`, so a worktree just nested under it is in view. */
function expand(set: SetFn, projectPath: string, path: string): void {
  set((s) => {
    const collapsed = getProject(s, projectPath).collapsedPaths;
    if (!collapsed?.includes(path)) return {};
    return {
      byProject: patchProject(s, projectPath, {
        collapsedPaths: collapsed.filter((p) => p !== path),
      }),
    };
  });
}

function patchEntry(
  set: SetFn,
  projectPath: string,
  worktreePath: string,
  patch: Partial<WorktreeEntry>,
): void {
  set((s) => ({
    byProject: patchProject(s, projectPath, {
      worktrees: getProject(s, projectPath).worktrees.map((wt) =>
        wt.path === worktreePath ? { ...wt, ...patch } : wt,
      ),
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

function markRemoving(set: SetFn, projectPath: string, worktreePath: string): void {
  set((s) => ({
    byProject: patchProject(s, projectPath, {
      worktrees: getProject(s, projectPath).worktrees.map((wt) =>
        wt.path === worktreePath ? { ...wt, pending: "removing" } : wt,
      ),
    }),
  }));
}
