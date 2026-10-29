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
import {
  archivedSet,
  buildWorktreeRows,
  buildWorktreeTree,
  resolveParents,
  type WorktreeNode,
  type WorktreeRow,
} from "@/lib/worktree-hierarchy";

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
  /** Worktrees moved to the project's Archive group, each with everything nested below it. Persisted. */
  archivedPaths?: string[];
  /** Worktrees whose nested worktrees are folded away in the sidebar. Persisted. */
  collapsedPaths?: string[];
}

const EMPTY_PROJECT: ProjectState = { worktrees: [] };

/** The per-project lists saved through server storage and synced across windows. */
const PERSISTED_KEYS = ["customOrder", "archivedPaths", "collapsedPaths"] as const;
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
    const record = entry as Record<string, unknown>;
    for (const key of PERSISTED_KEYS) {
      // Archive replaced "hide": worktrees saved as hidden come back archived.
      const value: unknown =
        record[key] ?? (key === "archivedPaths" ? record.hiddenPaths : undefined);
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

/** The project's worktrees split into the main list and its Archive group, each in display order. */
function splitArchived(ps: ProjectState): { listed: WorktreeEntry[]; archived: WorktreeEntry[] } {
  const ordered = getOrderedWorktrees(ps.worktrees, ps.customOrder);
  const archived = archivedSet(ps.worktrees, ps.archivedPaths ?? []);
  return {
    listed: ordered.filter((wt) => !archived.has(wt.path)),
    archived: ordered.filter((wt) => archived.has(wt.path)),
  };
}

/** The project's listed (not archived) worktrees as the sidebar shows them: nested, collapsed subtrees left out. */
export function getWorktreeRows(ps: ProjectState): WorktreeRow<WorktreeEntry>[] {
  return buildWorktreeRows(splitArchived(ps).listed, new Set(ps.collapsedPaths));
}

/** The listed and archived worktrees as trees, for rendering the sidebar. */
export function getWorktreeTrees(ps: ProjectState): {
  listed: WorktreeNode<WorktreeEntry>[];
  archived: WorktreeNode<WorktreeEntry>[];
} {
  const { listed, archived } = splitArchived(ps);
  return { listed: buildWorktreeTree(listed), archived: buildWorktreeTree(archived) };
}

/**
 * The worktrees `Ctrl+Alt+1`–`0` number: the sidebar's visible order without collapsed subtrees,
 * archived worktrees or pending entries, the same whether or not the sidebar is expanded.
 */
export function getNumberedWorktrees(ps: ProjectState): WorktreeEntry[] {
  return getWorktreeRows(ps)
    .filter((row) => !row.wt.pending)
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
  pendingAddPlan:
    | (AddWorktreePlan & { projectPath: string; parentPath?: string; title?: string })
    | null;
  /** Pending remove plan that needs user confirmation (dirty state). */
  pendingRemovePlan: (WorktreeRemovePlan & { wtPath: string; projectPath: string }) | null;

  /** Flag set by keybinding to trigger the inline create worktree UI. */
  createWorktreeRequested: boolean;
  /** Projects whose Archive group is open in the sidebar; every Archive starts closed. */
  openArchives: string[];

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

  /**
   * Create a worktree; with `parentPath`, a child branched from that worktree's commit, and with
   * `title`, shown by that title.
   */
  createWorktree: (
    projectPath: string,
    name: string,
    options?: Pick<CreateWorktreeOptions, "branch" | "parentPath" | "title">,
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
  /** Show `title` instead of the worktree name; empty shows the worktree name again. */
  setWorktreeTitle: (projectPath: string, path: string, title: string) => Promise<void>;
  /** Turn on worktree metadata for the project, so its worktrees can nest. */
  enableWorktreeMetadata: (projectPath: string) => Promise<void>;
  dismissPendingPlan: () => void;
  confirmCreateWorktree: (branchResolution: "use-existing" | "delete-and-create") => Promise<void>;

  requestCreateWorktree: () => void;
  clearCreateWorktreeRequest: () => void;

  setCustomOrder: (projectPath: string, orderedPaths: string[]) => void;
  /**
   * Move a worktree, with everything nested below it, to the project's Archive group, or back out.
   * A worktree archived as part of an ancestor brings that whole archived subtree back.
   */
  toggleArchived: (projectPath: string, path: string) => void;
  /**
   * Archive `path` in its own right, so it stays archived when it moves out of an archived
   * worktree it was archived with. Does nothing when it already is.
   */
  markArchived: (projectPath: string, path: string) => void;
  /** Open or close the project's Archive group. */
  toggleArchiveOpen: (projectPath: string) => void;
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
        openArchives: [],

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

          releaseWorktree(active);

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
          const title = options?.title;

          if (plan.branchConflict) {
            if (plan.branchConflict.kind === "used-by-worktree") {
              throw new Error(
                `A worktree already exists for branch '${plan.branch}' at: ${plan.branchConflict.worktreePath}`,
              );
            }
            set({ pendingAddPlan: { ...plan, projectPath, parentPath, title } });
            return;
          }

          addOptimisticEntry(set, projectPath, plan.worktreePath, name, { parentPath, title });

          try {
            await api.createWorktree(projectPath, name, {
              branch: options?.branch,
              parentPath,
              title,
            });
          } catch (err) {
            removeOptimisticEntry(set, projectPath, plan.worktreePath);
            throw err;
          }

          await get().refreshProjectWorktrees(projectPath);
        },

        confirmCreateWorktree: async (branchResolution) => {
          const { pendingAddPlan } = get();
          if (!pendingAddPlan) return;

          const { name, worktreePath, projectPath, parentPath, title } = pendingAddPlan;
          set({ pendingAddPlan: null });

          addOptimisticEntry(set, projectPath, worktreePath, name, { parentPath, title });

          try {
            await api.createWorktree(projectPath, name, { branchResolution, parentPath, title });
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
          const nestedPaths =
            nested === "remove" ? pendingRemovePlan.nested.map((wt) => wt.path) : [];
          const removed = [worktreePath, ...nestedPaths];

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
              ...(nested === "remove" ? { nestedPaths } : {}),
            });
          } catch (err) {
            for (const path of removed) removingPaths.delete(path);
            await get().refreshProjectWorktrees(projectPath);
            // Removing a subtree can fail partway: release whatever is gone all the same.
            const listed = new Set(getProject(get(), projectPath).worktrees.map((wt) => wt.path));
            for (const path of removed) if (!listed.has(path)) releaseWorktree(path);
            throw err;
          }
          for (const path of removed) {
            removingPaths.delete(path);
            releaseWorktree(path);
          }
          await get().refreshProjectWorktrees(projectPath);

          if (result.warning) throw new Error(result.warning);

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

        setWorktreeTitle: async (projectPath, path, title) => {
          const trimmed = title.trim();
          patchEntry(set, projectPath, path, { title: trimmed || undefined });
          try {
            await api.updateWorktreeMeta(projectPath, path, { title: trimmed || null });
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

        toggleArchived: (projectPath, wtPath) => {
          set((s) => {
            const ps = getProject(s, projectPath);
            return {
              byProject: patchProject(s, projectPath, {
                archivedPaths: toggleArchivedPaths(ps.worktrees, ps.archivedPaths ?? [], wtPath),
              }),
            };
          });
        },

        markArchived: (projectPath, wtPath) => {
          set((s) => {
            const current = getProject(s, projectPath).archivedPaths ?? [];
            if (current.includes(wtPath)) return {};
            return {
              byProject: patchProject(s, projectPath, { archivedPaths: [...current, wtPath] }),
            };
          });
        },

        toggleArchiveOpen: (projectPath) => {
          set((s) => ({ openArchives: [...toggleSet(new Set(s.openArchives), projectPath)] }));
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
            openArchives: [],
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

/** Drop the client state of a removed worktree and stop listening to it. */
function releaseWorktree(path: string): void {
  purgeWorktreeStores(path);
  purgeWorktreeCache(path);
  wsClient.unsubscribeWorktree(path);
}

/**
 * `archivedPaths` with `path` archived or brought back. Archiving drops archived paths below it,
 * which it now covers; bringing back a worktree archived through an ancestor brings back that
 * ancestor's whole subtree, including worktrees in it archived in their own right.
 */
export function toggleArchivedPaths(
  worktrees: readonly WorktreeEntry[],
  archivedPaths: readonly string[],
  path: string,
): string[] {
  const parents = resolveParents(worktrees);
  const ancestorsOf = (p: string): string[] => {
    const chain: string[] = [];
    for (let parent = parents.get(p); parent; parent = parents.get(parent)) chain.push(parent);
    return chain;
  };
  const current = new Set(archivedPaths);
  // The outermost archived root: bringing back an inner one alone would leave it covered.
  const root = [path, ...ancestorsOf(path)].filter((p) => current.has(p)).at(-1);
  if (root) return archivedPaths.filter((p) => p !== root && !ancestorsOf(p).includes(root));
  return [...archivedPaths.filter((p) => !ancestorsOf(p).includes(path)), path];
}

// ── Optimistic update helpers ──────────────────────────────────────────

type SetFn = (
  fn: WorktreeState | Partial<WorktreeState> | ((state: WorktreeState) => Partial<WorktreeState>),
) => void;

function addOptimisticEntry(
  set: SetFn,
  projectPath: string,
  worktreePath: string,
  name: string,
  { parentPath, title }: { parentPath?: string; title?: string },
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
    ...(title ? { title } : {}),
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
