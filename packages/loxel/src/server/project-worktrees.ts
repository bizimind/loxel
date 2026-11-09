/**
 * The worktree list Loxel shows for a project, and the worktree metadata Loxel owns: the parent
 * link that nests a worktree under another (`loxel-parent-wt`, a `wt-id`) and the title
 * shown instead of its name (`loxel-title`). Metadata is stored by `wt` and needs
 * `wt init --worktree-metadata on`.
 */
import { stat } from "node:fs/promises";
import { basename } from "node:path";

import {
  ensureWorktreeId,
  isWorktreeMetadataEnabled,
  listManagedWorktrees,
  setWorktreeMeta,
  unsetWorktreeMeta,
  WORKTREE_ID_KEY,
  type ManagedWorktree,
  type WorktreeMeta,
} from "@bizimind/wt/lib";

import type { WorktreeEntry } from "@/api/git-models";
import type { ProjectWorktreesResponse } from "@/api/project-model";
import { childrenByParent, descendantsOf, resolveParents } from "@/lib/worktree-hierarchy";

import { INTERNAL_WORKTREE_PREFIX } from "./worktree-utils";

export const PARENT_KEY = "loxel-parent-wt";
export const TITLE_KEY = "loxel-title";
/** Where titles were stored before `loxel-title`; still read, and cleared when a title is written. */
const LEGACY_TITLE_KEY = "loxel-pretty-name";

/** A listed worktree: always wt-managed, so it always has a wt name. */
export type ProjectWorktree = Omit<WorktreeEntry, "pending"> & { wtName: string };

/** The entry fields a worktree's metadata provides; empty values count as absent. */
function metaFields(meta: WorktreeMeta): Pick<WorktreeEntry, "wtId" | "parentWtId" | "title"> {
  const wtId = meta[WORKTREE_ID_KEY];
  const parentWtId = meta[PARENT_KEY];
  const title = (meta[TITLE_KEY] ?? meta[LEGACY_TITLE_KEY])?.trim();
  return {
    ...(wtId ? { wtId } : {}),
    ...(parentWtId ? { parentWtId } : {}),
    ...(title ? { title } : {}),
  };
}

/** A managed worktree as a list entry. */
export function toWorktreeEntry(wt: ManagedWorktree, createdAt: string | null): ProjectWorktree {
  return {
    path: wt.path,
    branch: wt.branch,
    commit: wt.head,
    isMain: false,
    createdAt,
    wtName: wt.name,
    ...metaFields(wt.meta),
  };
}

/** Managed worktrees minus Loxel's internal temporary ones. */
export function isListedWorktree(wt: ManagedWorktree): boolean {
  return !basename(wt.path).startsWith(INTERNAL_WORKTREE_PREFIX);
}

/** List wt-managed worktrees for a project (bare or regular). */
export async function listProjectWorktrees(projectPath: string): Promise<ProjectWorktree[]> {
  const managed = await listManagedWorktrees(projectPath);
  return Promise.all(
    managed
      .filter(isListedWorktree)
      .map(async (wt) => toWorktreeEntry(wt, await statCreatedAt(wt.path))),
  );
}

/** The worktree list plus whether worktrees can nest (GET /api/projects/:id/worktrees). */
export async function projectWorktreesResponse(
  projectPath: string,
): Promise<ProjectWorktreesResponse> {
  const [worktrees, worktreeMetadata] = await Promise.all([
    listProjectWorktrees(projectPath),
    isWorktreeMetadataEnabled(projectPath),
  ]);
  return { worktrees, worktreeMetadata };
}

async function statCreatedAt(dirPath: string): Promise<string | null> {
  try {
    const stats = await stat(dirPath);
    return stats.birthtime.toISOString();
  } catch {
    return null;
  }
}

/** The listed worktree at `path`, or an error naming it. */
function requireListed(worktrees: readonly ProjectWorktree[], path: string): ProjectWorktree {
  const found = worktrees.find((wt) => wt.path === path);
  if (!found) throw new Error(`No worktree at ${path}`);
  return found;
}

/** `parent`'s `wt-id`, assigning one if it has none yet (a worktree added outside wt). */
async function parentId(projectPath: string, parent: ProjectWorktree): Promise<string> {
  return parent.wtId ?? ensureWorktreeId({ repoPath: projectPath, path: parent.path });
}

/**
 * What creating a child of the worktree at `parentPath` needs: the parent's current commit to
 * branch from, and the metadata that nests the new worktree under it.
 */
export async function childWorktreeOptions(
  projectPath: string,
  parentPath: string,
): Promise<{ base: string; meta: WorktreeMeta }> {
  const parent = requireListed(await listProjectWorktrees(projectPath), parentPath);
  return { base: parent.commit, meta: { [PARENT_KEY]: await parentId(projectPath, parent) } };
}

/** The metadata that gives a new worktree `title`; none when it is empty. */
export function titleMeta(title: string | undefined): WorktreeMeta {
  const trimmed = title?.trim();
  return trimmed ? { [TITLE_KEY]: trimmed } : {};
}

/** The changes `updateWorktreeMeta` applies; `null` clears a value, an absent field keeps it. */
export interface WorktreeMetaUpdate {
  /** Nest under the worktree at this path, or move to the top level */
  parentPath?: string | null;
  /** Show this name instead of the worktree name; empty or null shows the worktree name again */
  title?: string | null;
}

/**
 * Apply Loxel's metadata changes to the worktree at `path`. A worktree cannot be nested under
 * itself or anything below it.
 */
export async function updateWorktreeMeta(
  projectPath: string,
  path: string,
  update: WorktreeMetaUpdate,
): Promise<void> {
  const worktrees = await listProjectWorktrees(projectPath);
  requireListed(worktrees, path);
  const values: WorktreeMeta = {};
  const keys: string[] = [];

  if (update.parentPath === null) keys.push(PARENT_KEY);
  else if (update.parentPath !== undefined) {
    const parent = requireListed(worktrees, update.parentPath);
    const below = descendantsOf(path, childrenByParent(resolveParents(worktrees)));
    if (parent.path === path || below.includes(parent.path)) {
      throw new Error("A worktree cannot be nested under itself or a worktree nested under it");
    }
    values[PARENT_KEY] = await parentId(projectPath, parent);
  }

  if (update.title !== undefined) {
    const title = update.title?.trim();
    if (title) values[TITLE_KEY] = title;
    else keys.push(TITLE_KEY);
    keys.push(LEGACY_TITLE_KEY);
  }

  if (Object.keys(values).length > 0)
    await setWorktreeMeta({ repoPath: projectPath, path, values });
  if (keys.length > 0) await unsetWorktreeMeta({ repoPath: projectPath, path, keys });
}

/** The worktrees nested below `path`: its direct children and every worktree below it. */
export function nestedBelow(
  worktrees: readonly ProjectWorktree[],
  path: string,
): { parent: ProjectWorktree | null; children: ProjectWorktree[]; descendants: ProjectWorktree[] } {
  const parents = resolveParents(worktrees);
  const children = childrenByParent(parents);
  const byPath = new Map(worktrees.map((wt) => [wt.path, wt]));
  const lookup = (paths: readonly string[]) =>
    paths.flatMap((p) => {
      const wt = byPath.get(p);
      return wt ? [wt] : [];
    });
  const parentPath = parents.get(path) ?? null;
  return {
    parent: parentPath === null ? null : (byPath.get(parentPath) ?? null),
    children: lookup(children.get(path) ?? []),
    descendants: lookup(descendantsOf(path, children)),
  };
}
