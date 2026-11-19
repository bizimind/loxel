import { create } from "zustand";
import { createJSONStorage, persist, subscribeWithSelector } from "zustand/middleware";

import type { AddWorktreePlan, CreateWorktreeOptions } from "@/api/client";
import * as api from "@/api/client";
import { wsClientOf } from "@/api/client";
import type { WorktreeEntry } from "@/api/git-models";
import { localServerId, whenLocalServerKnown } from "@/api/local-server";
import type { EnrichedProject } from "@/api/project-model";
import { hasConnection } from "@/api/server-connection";
import {
  type ServerId,
  type WorktreeRef,
  type WorktreeRefKey,
  formatWorktreeRef,
  parseWorktreeRef,
  sameWorktreeRef,
  worktreeRef,
  sameOptionalWorktreeRef,
} from "@/api/worktree-ref";
import type { NestedRemoval, WorktreeRemovePlan } from "@/api/worktree-removal-model";
import { showToast } from "@/components/ui/toast";
import { STORAGE_PREFIX } from "@/lib/env";
import { frontendLog } from "@/lib/frontend-logger";
import { dispatchLoxelEvent } from "@/lib/loxel-events";
import { findTreeRoot } from "@/lib/project-file-helpers";
import { offerToRunInitHook } from "@/lib/repo-trust-dialog";
import { toggleSet } from "@/lib/set-utils";
import {
  archivedSet,
  buildWorktreeRows,
  buildWorktreeTree,
  resolveParents,
  type WorktreeNode,
  type WorktreeRow,
} from "@/lib/worktree-hierarchy";
import { isKeyWithinWorktree } from "@/queries/query-keys";
import { queryClient } from "@/query-client";

import { layoutKeyOf } from "./active-worktree";
import { closeLayoutBrowserPages } from "./browser-pages";
import { type ListedProject, projectOf, projectRef, useProjectStore } from "./projects";
import { serverWorktreesStorage } from "./server-storage";
import { purgeWorktreeCache, transitionWorktreeState } from "./worktree-cache";
import { purgeWorktreeStores } from "./worktree-store";

const log = frontendLog.child("worktrees");

/** The window's active worktree as a {@link WorktreeRefKey}, kept across reloads of the page. */
const ACTIVE_WT_SESSION_KEY = `${STORAGE_PREFIX}-activeWorktree`;
/** The latest list refresh of each project, by its key. */
const refreshRequestIds = new Map<WorktreeRefKey, number>();
/** Worktrees with a removal request in flight; shown as pending across list refreshes. */
const removingKeys = new Set<WorktreeRefKey>();
/**
 * Worktrees with a create request in flight; shown as pending across list refreshes. Git registers
 * the worktree before its init hook runs, so the list can include it well before it is ready.
 */
const creatingKeys = new Set<WorktreeRefKey>();
let nextRefreshRequestId = 0;

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * The key of a worktree (or the root checkout) listed under `project`. A project's worktree list
 * comes from the project's server, so its paths are on that server.
 */
export function worktreeKey(project: WorktreeRef, path: string): WorktreeRefKey {
  return formatWorktreeRef(worktreeRef(project.server, path));
}

/** The worktree paths `keys` name on `project`'s server, the form the hierarchy helpers take. */
function pathsOn(project: WorktreeRef, keys: readonly WorktreeRefKey[]): string[] {
  return keys.flatMap((key) => {
    const ref = parseWorktreeRef(key);
    return ref?.server === project.server ? [ref.path] : [];
  });
}

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
  /** The project's worktrees, as its server lists them: their paths are on the project's server. */
  worktrees: WorktreeEntry[];
  /** User-defined worktree display order, across all nesting levels. Persisted. */
  customOrder?: WorktreeRefKey[];
  /** Worktrees moved to the project's Archive group, each with everything nested below it. Persisted. */
  archivedRefs?: WorktreeRefKey[];
  /** Worktrees whose nested worktrees are folded away in the sidebar. Persisted. */
  collapsedRefs?: WorktreeRefKey[];
}

const EMPTY_PROJECT: ProjectState = { worktrees: [] };

/** The per-project lists saved through server storage and synced across windows. */
const PERSISTED_KEYS = ["customOrder", "archivedRefs", "collapsedRefs"] as const;
type PersistedKey = (typeof PERSISTED_KEYS)[number];
export type PersistedProjectState = Pick<ProjectState, PersistedKey>;

/**
 * The names each list was saved under before, read when an entry has none by its current name.
 * Archive replaced "hide", so worktrees saved as hidden come back archived.
 */
const EARLIER_NAMES: Record<PersistedKey, readonly string[]> = {
  customOrder: [],
  archivedRefs: ["archivedPaths", "hiddenPaths"],
  collapsedRefs: ["collapsedPaths"],
};

/** The persisted lists of every project that has any, by project key. */
export function persistedProjectStates(
  byProject: Readonly<Record<WorktreeRefKey, ProjectState>>,
): Record<WorktreeRefKey, PersistedProjectState> {
  const persisted: Record<WorktreeRefKey, PersistedProjectState> = {};
  for (const [key, ps] of projectEntries(byProject)) {
    const saved: PersistedProjectState = {};
    for (const list of PERSISTED_KEYS) if (ps[list]) saved[list] = ps[list];
    if (Object.keys(saved).length > 0) persisted[key] = saved;
  }
  return persisted;
}

/** `byProject`'s entries with their keys typed. */
function projectEntries(
  byProject: Readonly<Record<WorktreeRefKey, ProjectState>>,
): [WorktreeRefKey, ProjectState][] {
  // Every key was written as a WorktreeRefKey: `byProject` takes no other.
  return Object.entries(byProject) as [WorktreeRefKey, ProjectState][];
}

/**
 * The start of an absolute path, POSIX or Windows (`C:\` or `C:/`). A ref's string form never
 * starts like one: it starts with its server's id, a UUID.
 */
const ABSOLUTE_PATH_START = /^(?:\/|[A-Za-z]:[\\/])/;

/**
 * A ref as saved: its string form, or a bare path saved before lists held refs. A bare path is
 * taken to be on `server`, the server whose window saved it, so a user's order and archive survive
 * the change; it is saved back as a ref.
 */
function savedRef(text: string, server: ServerId): WorktreeRef {
  if (ABSOLUTE_PATH_START.test(text)) return worktreeRef(server, text);
  return parseWorktreeRef(text) ?? worktreeRef(server, text);
}

/**
 * `byProject` with saved lists (untrusted: from storage or another window) applied over each
 * project's entry, keeping its runtime data (worktree list, etc.). Projects and worktrees saved as
 * bare paths are read as on `server`, the window's own.
 */
export function mergePersistedProjectStates(
  byProject: Readonly<Record<WorktreeRefKey, ProjectState>>,
  saved: unknown,
  server: ServerId,
): Record<WorktreeRefKey, ProjectState> {
  const merged = { ...byProject };
  if (!saved || typeof saved !== "object") return merged;
  for (const [savedKey, entry] of Object.entries(saved)) {
    if (!entry || typeof entry !== "object") continue;
    const project = savedRef(savedKey, server);
    const key = formatWorktreeRef(project);
    const next: ProjectState = { ...(merged[key] ?? { worktrees: [] }) };
    const record = entry as Record<string, unknown>;
    for (const list of PERSISTED_KEYS) {
      const value = [list, ...EARLIER_NAMES[list]]
        .map((name) => record[name])
        .find((v): v is unknown[] => Array.isArray(v));
      if (!value) continue;
      next[list] = value.flatMap((item) =>
        // A project's worktrees are on its server.
        typeof item === "string" ? [formatWorktreeRef(savedRef(item, project.server))] : [],
      );
    }
    merged[key] = next;
  }
  return merged;
}

/** The persisted lists pruned to the project's worktrees that still exist. */
function prunePersisted(
  project: WorktreeRef,
  ps: ProjectState | undefined,
  validPaths: ReadonlySet<string>,
): PersistedProjectState {
  const valid = new Set([...validPaths].map((path) => worktreeKey(project, path)));
  return Object.fromEntries(
    PERSISTED_KEYS.map((list) => [list, ps?.[list]?.filter((key) => valid.has(key))]),
  ) as PersistedProjectState;
}

/** A project's persisted lists as worktree paths on its server, the form the hierarchy helpers take. */
export interface ProjectListPaths {
  /** The custom display order; undefined while the user has set none. */
  order: string[] | undefined;
  archived: string[];
  collapsed: string[];
}

/** {@link ProjectListPaths} of `project`, whose state is `ps`. */
export function projectListPaths(project: WorktreeRef, ps: ProjectState): ProjectListPaths {
  return {
    order: ps.customOrder && pathsOn(project, ps.customOrder),
    archived: pathsOn(project, ps.archivedRefs ?? []),
    collapsed: pathsOn(project, ps.collapsedRefs ?? []),
  };
}

/** The project's worktrees split into the main list and its Archive group, each in display order. */
function splitArchived(
  ps: ProjectState,
  lists: ProjectListPaths,
): { listed: WorktreeEntry[]; archived: WorktreeEntry[] } {
  const ordered = getOrderedWorktrees(ps.worktrees, lists.order);
  const archived = archivedSet(ps.worktrees, lists.archived);
  return {
    listed: ordered.filter((wt) => !archived.has(wt.path)),
    archived: ordered.filter((wt) => archived.has(wt.path)),
  };
}

/** The project's listed (not archived) worktrees as the sidebar shows them: nested, collapsed subtrees left out. */
export function getWorktreeRows(
  project: WorktreeRef,
  ps: ProjectState,
): WorktreeRow<WorktreeEntry>[] {
  const lists = projectListPaths(project, ps);
  return buildWorktreeRows(splitArchived(ps, lists).listed, new Set(lists.collapsed));
}

/** The listed and archived worktrees as trees, for rendering the sidebar. */
export function getWorktreeTrees(
  project: WorktreeRef,
  ps: ProjectState,
): { listed: WorktreeNode<WorktreeEntry>[]; archived: WorktreeNode<WorktreeEntry>[] } {
  const { listed, archived } = splitArchived(ps, projectListPaths(project, ps));
  return { listed: buildWorktreeTree(listed), archived: buildWorktreeTree(archived) };
}

/**
 * The worktrees `Ctrl+Alt+1`–`0` number: the sidebar's visible order without collapsed subtrees,
 * archived worktrees or pending entries, the same whether or not the sidebar is expanded.
 */
export function getNumberedWorktrees(project: WorktreeRef, ps: ProjectState): WorktreeEntry[] {
  return getWorktreeRows(project, ps)
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
  projects: readonly Pick<ListedProject, "server" | "path" | "isBare" | "worktrees">[],
  byProject: Readonly<Record<WorktreeRefKey, Pick<ProjectState, "worktrees">>>,
): string | null {
  const roots = projects.flatMap((project) => {
    const worktrees =
      byProject[formatWorktreeRef(projectRef(project))]?.worktrees ?? project.worktrees;
    const worktreeRoots = worktrees.map((worktree) => worktree.path);
    return project.isBare ? worktreeRoots : [...worktreeRoots, project.path];
  });
  return findTreeRoot(path, roots);
}

// ── Worktree store ──────────────────────────────────────────────────────

/**
 * A worktree create that has started. It runs in the background (the repo's init hook can take a
 * while) and reports a failure as an error toast, since whoever started it has moved on.
 */
export interface CreateStarted {
  /** Settles when the create has finished: whether it succeeded. Never rejects. */
  created: Promise<boolean>;
}

export interface WorktreeState {
  /** All per-project state keyed by project ref. */
  byProject: Record<WorktreeRefKey, ProjectState>;
  /** The worktree (or regular repo's root checkout) the window shows; null for Home. */
  activeWorktree: WorktreeRef | null;

  /** Pending add plan that needs user resolution (branch conflict). */
  pendingAddPlan:
    | (AddWorktreePlan & { project: WorktreeRef } & Pick<
          CreateWorktreeOptions,
          "parentPath" | "fromParent" | "title"
        >)
    | null;
  /** Pending remove plan that needs user confirmation (dirty state). */
  pendingRemovePlan: (WorktreeRemovePlan & { wtPath: string; project: WorktreeRef }) | null;

  /** Flag set by keybinding to trigger the inline create worktree UI. */
  createWorktreeRequested: boolean;
  /** Projects whose Archive group is open in the sidebar; every Archive starts closed. */
  openArchives: WorktreeRefKey[];

  /**
   * Apply `server`'s project list (called by the project store after fetchProjects). Only that
   * server's projects change: those it no longer lists are dropped with their persisted lists, and
   * the active worktree moves only off a worktree of that server it no longer lists (or of a server
   * the window has no connection to).
   */
  applyEnrichedProjects: (server: ServerId, enriched: readonly ListedProject[]) => void;

  /** Refresh worktrees for a single project (called by ws-bridge on worktrees_changed). */
  refreshProjectWorktrees: (project: WorktreeRef) => Promise<void>;

  /**
   * Switch to a worktree, or a regular repo's root checkout. Server supports multiple concurrent
   * projects, so no project switch is needed. All state updates are optimistic (before API calls)
   * to prevent WS race conditions.
   */
  switchWorktree: (wt: WorktreeRef) => Promise<void>;

  /** Show Home, the layout with no worktree active (its own browsers, terminals and plans). */
  showHome: () => void;

  /**
   * Create a worktree; with `parentPath`, a child nested under that worktree (branched from its
   * commit with `fromParent`, otherwise from the remote default), and with `title`, shown by that
   * title. Resolves once the create has started, as a pending sidebar entry
   * (null when a branch conflict was parked in `pendingAddPlan` instead); rejects only when the
   * create cannot start. See {@link CreateStarted} for the rest.
   */
  createWorktree: (
    project: WorktreeRef,
    name: string,
    options?: Pick<CreateWorktreeOptions, "branch" | "parentPath" | "fromParent" | "title">,
  ) => Promise<CreateStarted | null>;
  requestRemoveWorktree: (project: WorktreeRef, wt: WorktreeEntry) => Promise<void>;
  confirmRemoveWorktree: (options: {
    deleteBranch: boolean;
    force: boolean;
    nested?: NestedRemoval;
  }) => Promise<void>;
  /** Nest a worktree under another, or move it to the top level (`parentPath: null`). */
  setWorktreeParent: (
    project: WorktreeRef,
    path: string,
    parentPath: string | null,
  ) => Promise<void>;
  /** Show `title` instead of the worktree name; empty shows the worktree name again. */
  setWorktreeTitle: (project: WorktreeRef, path: string, title: string) => Promise<void>;
  /** Turn on worktree metadata for the project, so its worktrees can nest. */
  enableWorktreeMetadata: (project: WorktreeRef) => Promise<void>;
  dismissPendingPlan: () => void;
  /** Create the worktree of the parked `pendingAddPlan`, the way `createWorktree` does. */
  confirmCreateWorktree: (
    branchResolution: "use-existing" | "delete-and-create",
  ) => Promise<CreateStarted | null>;

  requestCreateWorktree: () => void;
  clearCreateWorktreeRequest: () => void;

  /** Set the display order of the project's worktrees, given as paths on its server. */
  setCustomOrder: (project: WorktreeRef, orderedPaths: readonly string[]) => void;
  /**
   * Move a worktree, with everything nested below it, to the project's Archive group, or back out.
   * A worktree archived as part of an ancestor brings that whole archived subtree back.
   */
  toggleArchived: (project: WorktreeRef, path: string) => void;
  /**
   * Archive `path` in its own right, so it stays archived when it moves out of an archived
   * worktree it was archived with. Does nothing when it already is.
   */
  markArchived: (project: WorktreeRef, path: string) => void;
  /** Open or close the project's Archive group. */
  toggleArchiveOpen: (project: WorktreeRef) => void;
  /** Fold or unfold the worktrees nested below `path`. */
  toggleCollapsed: (project: WorktreeRef, path: string) => void;
  reset: () => void;
}

/**
 * The store fields that make `wt` active, or Home when null: the one way to change the active
 * worktree.
 */
export function activeWorktreeFields(
  wt: WorktreeRef | null,
): Pick<WorktreeState, "activeWorktree"> {
  return { activeWorktree: wt };
}

/**
 * {@link activeWorktreeFields}, or none when `wt` names the active worktree already, so the ref
 * subscribers hold stays the same object.
 */
function activeWorktreeChange(
  state: WorktreeState,
  wt: WorktreeRef | null,
): Partial<WorktreeState> {
  const current = state.activeWorktree;
  if (sameOptionalWorktreeRef(current, wt)) return {};
  return activeWorktreeFields(wt);
}

/** The active worktree saved in this tab's session, if it is a ref. */
function sessionActiveWorktree(): WorktreeRef | null {
  const saved = sessionStorage.getItem(ACTIVE_WT_SESSION_KEY);
  return saved === null ? null : parseWorktreeRef(saved);
}

/** Get the project state entry, falling back to a stable empty default. */
function getProject(state: WorktreeState, project: WorktreeRef): ProjectState {
  return state.byProject[formatWorktreeRef(project)] ?? EMPTY_PROJECT;
}

/** Return a new byProject with a patched entry for one project. */
function patchProject(
  state: WorktreeState,
  project: WorktreeRef,
  patch: Partial<ProjectState>,
): Record<WorktreeRefKey, ProjectState> {
  return {
    ...state.byProject,
    [formatWorktreeRef(project)]: { ...getProject(state, project), ...patch },
  };
}

/** Find a listed project by its ref. */
function findProject(project: WorktreeRef): ListedProject | undefined {
  return useProjectStore
    .getState()
    .projects.find((candidate) => sameWorktreeRef(projectRef(candidate), project));
}

export const useWorktreeStore = create<WorktreeState>()(
  subscribeWithSelector(
    persist(
      (set, get) => ({
        byProject: {},
        ...activeWorktreeFields(sessionActiveWorktree()),
        pendingAddPlan: null,
        pendingRemovePlan: null,
        createWorktreeRequested: false,
        openArchives: [],

        applyEnrichedProjects: (server, enriched) => {
          set((s) => {
            const listedKeys = new Set(enriched.map((p) => formatWorktreeRef(projectRef(p))));
            const byProject = Object.fromEntries(
              projectEntries(s.byProject).filter(
                ([key]) => parseWorktreeRef(key)?.server !== server || listedKeys.has(key),
              ),
            );

            for (const p of enriched) {
              const project = projectRef(p);
              const key = formatWorktreeRef(project);
              const existing = byProject[key];
              const effectiveWorktrees =
                p.worktrees.length > 0 ? p.worktrees : (existing?.worktrees ?? []);
              const validPaths = new Set(effectiveWorktrees.map((wt) => wt.path));
              byProject[key] = {
                worktrees: withRequestsInFlight(
                  project,
                  effectiveWorktrees,
                  existing?.worktrees ?? [],
                ),
                worktreesDir: p.worktreesDir,
                worktreeMetadata: p.worktreeMetadata,
                ...prunePersisted(project, existing, validPaths),
              };
            }

            return { byProject };
          });

          // Validate: if the hydrated active worktree no longer exists, fall back. Another
          // server's says nothing about this list, unless the window has no connection to it (a
          // session restored after the server's id changed).
          const active = get().activeWorktree;
          if (!active || (active.server !== server && hasConnection(active.server))) return;
          const listed = new Set(
            enriched.flatMap((p) => {
              const project = projectRef(p);
              return [
                formatWorktreeRef(project),
                ...p.worktrees.map((wt) => worktreeKey(project, wt.path)),
              ];
            }),
          );
          if (listed.has(formatWorktreeRef(active))) return;
          const first = enriched[0];
          const fallbackPath = first?.isBare ? first.worktrees[0]?.path : first?.path;
          set(
            activeWorktreeFields(
              first && fallbackPath ? worktreeRef(first.server, fallbackPath) : null,
            ),
          );
        },

        refreshProjectWorktrees: async (project) => {
          const key = formatWorktreeRef(project);
          const requestId = ++nextRefreshRequestId;
          refreshRequestIds.set(key, requestId);
          const listed = findProject(project);
          if (!listed) return;
          const prior = getProject(get(), project).worktrees;
          const priorPaths = new Set(prior.map((wt) => wt.path));

          const data = await api.getProjectWorktrees(project.server, listed.id);
          if (refreshRequestIds.get(key) !== requestId) return;
          const validPaths = new Set([
            ...data.worktrees.map((wt) => wt.path),
            ...(listed.isBare ? [] : [project.path]),
          ]);

          set((s) => {
            const existing = getProject(s, project);
            return {
              byProject: patchProject(s, project, {
                worktrees: withRequestsInFlight(project, data.worktrees, existing.worktrees),
                worktreeMetadata: data.worktreeMetadata,
                ...prunePersisted(project, existing, validPaths),
              }),
            };
          });

          // Whether removed or moved, in this window or anywhere else, by the app or by `wt`.
          for (const wt of prior) {
            if (wt.pending !== "creating" && !validPaths.has(wt.path)) {
              releaseWorktree(worktreeRef(project.server, wt.path));
            }
          }

          const active = get().activeWorktree;
          if (!active || active.server !== project.server || validPaths.has(active.path)) return;
          const activeProject = projectOf(active, useProjectStore.getState().projects);
          const belongedToProject =
            active.path === project.path ||
            priorPaths.has(active.path) ||
            (activeProject !== null && sameWorktreeRef(projectRef(activeProject), project));
          if (!belongedToProject) return;

          releaseWorktree(active);

          const fallbackPath = listed.isBare ? data.worktrees[0]?.path : project.path;
          set(
            activeWorktreeFields(fallbackPath ? worktreeRef(project.server, fallbackPath) : null),
          );
          if (fallbackPath) transitionWorktreeState();
        },

        switchWorktree: async (wt) => {
          // 1. Set the active worktree OPTIMISTICALLY (before API calls)
          set((s) => activeWorktreeChange(s, wt));

          // 2. Transition worktree state (clears comments)
          transitionWorktreeState();

          // 3. No server API call needed — server supports concurrent projects.
          // WebSocket subscription is handled by the subscription lifecycle in App.tsx.
        },

        showHome: () => {
          if (get().activeWorktree === null) return;
          set(activeWorktreeFields(null));
          transitionWorktreeState();
        },

        createWorktree: async (project, name, options) => {
          const plan = await api.planAddWorktree(project, name);
          const parentPath = options?.parentPath;
          const fromParent = options?.fromParent;
          const title = options?.title;

          if (plan.branchConflict) {
            if (plan.branchConflict.kind === "used-by-worktree") {
              throw new Error(
                `A worktree already exists for branch '${plan.branch}' at: ${plan.branchConflict.worktreePath}`,
              );
            }
            set({ pendingAddPlan: { ...plan, project, parentPath, fromParent, title } });
            return null;
          }

          return startCreate(set, get, project, plan.worktreePath, name, {
            branch: options?.branch,
            parentPath,
            fromParent,
            title,
          });
        },

        confirmCreateWorktree: async (branchResolution) => {
          const { pendingAddPlan } = get();
          if (!pendingAddPlan) return null;

          const { name, worktreePath, project, parentPath, fromParent, title } = pendingAddPlan;
          set({ pendingAddPlan: null });

          return startCreate(set, get, project, worktreePath, name, {
            branchResolution,
            parentPath,
            fromParent,
            title,
          });
        },

        requestRemoveWorktree: async (project, wt) => {
          const plan = await api.planRemoveWorktree(project, wt.path);
          set({ pendingRemovePlan: { ...plan, wtPath: wt.path, project } });
        },

        confirmRemoveWorktree: async ({ deleteBranch, force, nested = "move-up" }) => {
          const { pendingRemovePlan } = get();
          if (!pendingRemovePlan) return;

          const { wtPath, worktreePath, project } = pendingRemovePlan;
          set({ pendingRemovePlan: null });
          const nestedPaths =
            nested === "remove" ? pendingRemovePlan.nested.map((wt) => wt.path) : [];
          const removed = [worktreePath, ...nestedPaths].map((path) =>
            worktreeRef(project.server, path),
          );

          // Not removed optimistically: the entries stay, marked pending, until the server has
          // unregistered the worktrees (their files are deleted afterwards, in the background).
          for (const wt of removed) {
            removingKeys.add(formatWorktreeRef(wt));
            markRemoving(set, project, wt.path);
          }
          let result: Awaited<ReturnType<typeof api.removeWorktreeByWtPath>>;
          try {
            result = await api.removeWorktreeByWtPath(project, wtPath, {
              deleteBranch,
              force,
              nested,
              ...(nested === "remove" ? { nestedPaths } : {}),
            });
          } catch (err) {
            for (const wt of removed) removingKeys.delete(formatWorktreeRef(wt));
            await get().refreshProjectWorktrees(project);
            // Removing a subtree can fail partway: release whatever is gone all the same.
            const listed = new Set(getProject(get(), project).worktrees.map((wt) => wt.path));
            for (const wt of removed) if (!listed.has(wt.path)) releaseWorktree(wt, true);
            throw err;
          }
          for (const wt of removed) {
            removingKeys.delete(formatWorktreeRef(wt));
            releaseWorktree(wt, true);
          }
          await get().refreshProjectWorktrees(project);

          if (result.warning) throw new Error(result.warning);

          if (deleteBranch && !result.branchDeleted) {
            throw new Error(
              "The worktree was removed, but its branch could not be deleted. The branch was kept.",
            );
          }
        },

        setWorktreeParent: async (project, path, parentPath) => {
          const parent = parentPath
            ? getProject(get(), project).worktrees.find((wt) => wt.path === parentPath)
            : undefined;
          // Show the move at once when the parent already has an id; the refresh confirms it.
          if (parentPath === null || parent?.wtId) {
            patchEntry(set, project, path, { parentWtId: parent?.wtId });
          }
          if (parentPath) expand(set, project, parentPath);
          try {
            await api.updateWorktreeMeta(project, path, { parentPath });
          } finally {
            await get().refreshProjectWorktrees(project);
          }
        },

        setWorktreeTitle: async (project, path, title) => {
          const trimmed = title.trim();
          patchEntry(set, project, path, { title: trimmed || undefined });
          try {
            await api.updateWorktreeMeta(project, path, { title: trimmed || null });
          } finally {
            await get().refreshProjectWorktrees(project);
          }
        },

        enableWorktreeMetadata: async (project) => {
          await api.enableWorktreeMetadata(project);
          await get().refreshProjectWorktrees(project);
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

        setCustomOrder: (project, orderedPaths) => {
          const customOrder = orderedPaths.map((path) => worktreeKey(project, path));
          set((s) => ({ byProject: patchProject(s, project, { customOrder }) }));
        },

        toggleArchived: (project, wtPath) => {
          set((s) => {
            const ps = getProject(s, project);
            const archived = toggleArchivedPaths(
              ps.worktrees,
              pathsOn(project, ps.archivedRefs ?? []),
              wtPath,
            );
            return {
              byProject: patchProject(s, project, {
                archivedRefs: archived.map((path) => worktreeKey(project, path)),
              }),
            };
          });
        },

        markArchived: (project, wtPath) => {
          const key = worktreeKey(project, wtPath);
          set((s) => {
            const current = getProject(s, project).archivedRefs ?? [];
            if (current.includes(key)) return {};
            return { byProject: patchProject(s, project, { archivedRefs: [...current, key] }) };
          });
        },

        toggleArchiveOpen: (project) => {
          const key = formatWorktreeRef(project);
          set((s) => ({ openArchives: [...toggleSet(new Set(s.openArchives), key)] }));
        },

        toggleCollapsed: (project, wtPath) => {
          const key = worktreeKey(project, wtPath);
          set((s) => {
            const current = getProject(s, project).collapsedRefs ?? [];
            return {
              byProject: patchProject(s, project, {
                collapsedRefs: [...toggleSet(new Set(current), key)],
              }),
            };
          });
        },

        reset: () => {
          refreshRequestIds.clear();
          removingKeys.clear();
          creatingKeys.clear();
          set({
            byProject: {},
            ...activeWorktreeFields(null),
            pendingAddPlan: null,
            pendingRemovePlan: null,
            createWorktreeRequested: false,
            openArchives: [],
          });
        },
      }),
      {
        name: `${STORAGE_PREFIX}-worktrees`,
        // Lists saved before they held refs hold bare paths, which name the window's server, so
        // they load once it is known.
        storage: createJSONStorage(() => ({
          ...serverWorktreesStorage,
          getItem: async (name: string) => {
            // Started at once, only the result waits for the server: the later the saved lists
            // arrive, the likelier a store update lands first and saves empty lists over them.
            const saved = serverWorktreesStorage.getItem(name);
            await whenLocalServerKnown();
            return saved;
          },
        })),
        partialize: (state) => ({ byProject: persistedProjectStates(state.byProject) }),
        merge: (persisted, current) => {
          if (!persisted || typeof persisted !== "object" || !("byProject" in persisted)) {
            return current;
          }
          return {
            ...current,
            byProject: mergePersistedProjectStates(
              current.byProject,
              persisted.byProject,
              localServerId(),
            ),
          };
        },
      },
    ),
  ),
);

useWorktreeStore.subscribe(
  (s) => s.activeWorktree,
  (wt) => {
    if (wt) {
      sessionStorage.setItem(ACTIVE_WT_SESSION_KEY, formatWorktreeRef(wt));
    } else {
      sessionStorage.removeItem(ACTIVE_WT_SESSION_KEY);
    }
  },
);

/** A worktree in this window's lists, as a ref, with its entry. */
export interface ListedWorktree {
  ref: WorktreeRef;
  entry: WorktreeEntry;
}

/** Every worktree in this window's lists (not the regular repos' root checkouts). */
export function listedWorktrees(): ListedWorktree[] {
  return projectEntries(useWorktreeStore.getState().byProject).flatMap(([key, ps]) => {
    const project = parseWorktreeRef(key);
    if (!project) return [];
    return ps.worktrees.map((entry) => ({ ref: worktreeRef(project.server, entry.path), entry }));
  });
}

/** Whether `wt` is a worktree or a regular project's root checkout in this window's lists. */
export function isListedWorktree(wt: WorktreeRef): boolean {
  return (
    listedWorktrees().some(({ ref }) => sameWorktreeRef(ref, wt)) ||
    useProjectStore.getState().projects.some((p) => !p.isBare && sameWorktreeRef(projectRef(p), wt))
  );
}

/**
 * Drop the client state of a removed worktree and stop listening to it, so a worktree later created
 * at the same path starts fresh. `discarded`: the user removed it in Loxel, giving up what it held.
 */
function releaseWorktree(wt: WorktreeRef, discarded = false): void {
  purgeWorktreeStores(wt);
  closeLayoutBrowserPages(layoutKeyOf(wt));
  purgeWorktreeCache(wt);
  const homeServer = localServerId();
  queryClient.removeQueries({
    predicate: ({ queryKey }) => isKeyWithinWorktree(queryKey, wt, homeServer),
  });
  // A server without a connection holds no subscription of this window: nothing to end there.
  if (hasConnection(wt.server)) wsClientOf(wt.server).unsubscribeWorktree(wt);
  dispatchLoxelEvent("loxel-worktree-gone", { wt, discarded });
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

/**
 * A worktree list from the server with the requests in flight applied over it: listed worktrees
 * get their pending marker, and the `current` entries of worktrees being created that the list
 * does not have yet (git had not registered them when it was read) are kept.
 */
function withRequestsInFlight(
  project: WorktreeRef,
  listed: readonly WorktreeEntry[],
  current: readonly WorktreeEntry[],
): WorktreeEntry[] {
  const listedPaths = new Set(listed.map((wt) => wt.path));
  const stillCreating = current.filter(
    (wt) => creatingKeys.has(worktreeKey(project, wt.path)) && !listedPaths.has(wt.path),
  );
  return [...listed.map((wt) => withPendingMarker(project, wt)), ...stillCreating];
}

/** A listed worktree with the marker of the request in flight for it, if any. */
function withPendingMarker(project: WorktreeRef, wt: WorktreeEntry): WorktreeEntry {
  const key = worktreeKey(project, wt.path);
  if (removingKeys.has(key)) return { ...wt, pending: "removing" };
  if (creatingKeys.has(key)) return { ...wt, pending: "creating" };
  return wt;
}

/** Show the pending entry and create the worktree in the background. */
function startCreate(
  set: SetFn,
  get: () => WorktreeState,
  project: WorktreeRef,
  worktreePath: string,
  name: string,
  options: CreateWorktreeOptions,
): CreateStarted {
  const key = worktreeKey(project, worktreePath);
  // The dialog closes once a create starts, so the same name can be submitted again meanwhile.
  if (creatingKeys.has(key)) {
    throw new Error(`Worktree '${name}' is already being created`);
  }
  creatingKeys.add(key);
  addOptimisticEntry(set, project, worktreePath, name, options);
  return { created: finishCreate(set, get, project, worktreePath, name, options) };
}

async function finishCreate(
  set: SetFn,
  get: () => WorktreeState,
  project: WorktreeRef,
  worktreePath: string,
  name: string,
  options: CreateWorktreeOptions,
): Promise<boolean> {
  let created = true;
  try {
    const result = await api.createWorktree(project, name, options);
    if (result.hookSkipped) void offerToRunInitHook(project, result.path);
  } catch (err) {
    created = false;
    const reason = err instanceof Error ? err.message : String(err);
    log.warn(`Failed to create worktree '${name}'`, { projectPath: project.path, error: err });
    showToast(`Could not create worktree '${name}': ${reason}`);
  } finally {
    creatingKeys.delete(worktreeKey(project, worktreePath));
  }
  // Gone at once on failure; the refresh brings it back if the create got as far as git.
  if (!created) removeOptimisticEntry(set, project, worktreePath);
  try {
    await get().refreshProjectWorktrees(project);
  } catch (err) {
    log.warn("Could not refresh the worktree list after creating a worktree", {
      projectPath: project.path,
      error: err,
    });
    // Ready all the same; the next refresh fills in what the optimistic entry lacks.
    if (created) patchEntry(set, project, worktreePath, { pending: undefined });
  }
  return created;
}

function addOptimisticEntry(
  set: SetFn,
  project: WorktreeRef,
  worktreePath: string,
  name: string,
  { parentPath, title }: { parentPath?: string; title?: string },
): void {
  const parentWtId = parentPath
    ? getProject(useWorktreeStore.getState(), project).worktrees.find(
        (wt) => wt.path === parentPath,
      )?.wtId
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
  if (parentPath) expand(set, project, parentPath);
  set((s) => ({
    byProject: patchProject(s, project, {
      worktrees: [...getProject(s, project).worktrees, optimistic],
    }),
  }));
}

/** Unfold `path`, so a worktree just nested under it is in view. */
function expand(set: SetFn, project: WorktreeRef, path: string): void {
  const key = worktreeKey(project, path);
  set((s) => {
    const collapsed = getProject(s, project).collapsedRefs;
    if (!collapsed?.includes(key)) return {};
    return {
      byProject: patchProject(s, project, { collapsedRefs: collapsed.filter((k) => k !== key) }),
    };
  });
}

function patchEntry(
  set: SetFn,
  project: WorktreeRef,
  worktreePath: string,
  patch: Partial<WorktreeEntry>,
): void {
  set((s) => ({
    byProject: patchProject(s, project, {
      worktrees: getProject(s, project).worktrees.map((wt) =>
        wt.path === worktreePath ? { ...wt, ...patch } : wt,
      ),
    }),
  }));
}

function removeOptimisticEntry(set: SetFn, project: WorktreeRef, worktreePath: string): void {
  set((s) => ({
    byProject: patchProject(s, project, {
      worktrees: getProject(s, project).worktrees.filter((wt) => wt.path !== worktreePath),
    }),
  }));
}

function markRemoving(set: SetFn, project: WorktreeRef, worktreePath: string): void {
  set((s) => ({
    byProject: patchProject(s, project, {
      worktrees: getProject(s, project).worktrees.map((wt) =>
        wt.path === worktreePath ? { ...wt, pending: "removing" } : wt,
      ),
    }),
  }));
}
