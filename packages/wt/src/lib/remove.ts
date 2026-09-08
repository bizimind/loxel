import { resolve } from "node:path";

import { deleteBranch, isWorktreeDirty, removeWorktree } from "../git/index.ts";
import { HOOK_CLEAN, runHook } from "../hooks/run.ts";
import { silentProgress, type ProgressHandler } from "../progress.ts";
import { locateWorktree } from "./worktrees.ts";

export interface RemovePlan {
  /** The worktree name */
  name: string;
  /** Absolute path to the worktree */
  worktreePath: string;
  /** Branch name, or null when detached */
  branch: string | null;
  /** Uncommitted or untracked files present — `git worktree remove` refuses both */
  dirty: boolean;
  /** The main worktree, which cannot be removed */
  isMain: boolean;
}

export interface RemoveParams {
  name: string;
  /** Any path inside the repository (bare or non-bare) */
  repoPath: string;
  /** Also delete the worktree's branch */
  deleteBranch: boolean;
  /** Remove even when the worktree is dirty */
  force: boolean;
  /** Force-delete an unmerged branch after removal (never implied by `force`). */
  forceBranch?: boolean;
  /** When provided, reject if `name` resolves to a different worktree path. */
  expectedPath?: string;
  /**
   * Base environment for the clean hook (default: process.env). Use to provide
   * a resolved shell PATH when calling from a non-shell context (e.g. a GUI app).
   */
  hookEnv?: Record<string, string>;
}

export interface RemoveResult {
  name: string;
  path: string;
  /** The worktree was removed */
  removed: boolean;
  branchDeleted: boolean;
  /** clean.wt.sh existed and succeeded */
  hookRan: boolean;
}

/**
 * Inspect a worktree before removing it.
 * No mutations — safe to call speculatively.
 */
export async function planRemove(params: { name: string; repoPath: string }): Promise<RemovePlan> {
  const { root, worktree } = await locateWorktree(params.name, params.repoPath);

  return {
    name: params.name,
    worktreePath: worktree.path,
    branch: worktree.branch,
    dirty: await isWorktreeDirty(worktree.path),
    isMain: worktree.path === root,
  };
}

/**
 * Run the clean hook, then remove the worktree and optionally its branch.
 *
 * Throws when the worktree is dirty and `force` is not set, or when it is the
 * main worktree.
 */
export async function executeRemove(
  params: RemoveParams,
  progress: ProgressHandler = silentProgress,
): Promise<RemoveResult> {
  const { name, repoPath, force } = params;
  const { root, worktree } = await locateWorktree(name, repoPath);

  if (params.expectedPath && resolve(worktree.path) !== resolve(params.expectedPath)) {
    throw new Error(`Worktree '${name}' resolved to an unexpected path: ${worktree.path}`);
  }

  if (worktree.path === root) {
    throw new Error("Refusing to remove the main worktree.");
  }
  if (!force && (await isWorktreeDirty(worktree.path))) {
    throw new Error(
      `Worktree '${name}' has uncommitted or untracked changes. Use force to remove it anyway.`,
    );
  }

  const hookRan = await runHook(
    HOOK_CLEAN,
    { root, name, worktreePath: worktree.path, branch: worktree.branch, baseEnv: params.hookEnv },
    progress,
  );

  progress.log(`Removing worktree '${name}'...`);
  await removeWorktree(root, worktree.path, force);

  const branchDeleted = await tryDeleteBranch(
    root,
    worktree.branch,
    params.deleteBranch,
    params.forceBranch ?? false,
    progress,
  );

  return { name, path: worktree.path, removed: true, branchDeleted, hookRan };
}

/** Branch deletion is recoverable, so a failure warns rather than throws. */
async function tryDeleteBranch(
  root: string,
  branch: string | null,
  shouldDelete: boolean,
  force: boolean,
  progress: ProgressHandler,
): Promise<boolean> {
  if (!shouldDelete || !branch) return false;

  try {
    await deleteBranch(root, branch, force);
    progress.log(`Deleted branch '${branch}'`);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    progress.warn(`Warning: could not delete branch '${branch}': ${message}`);
    return false;
  }
}
