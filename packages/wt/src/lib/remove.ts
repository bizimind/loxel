import { dirname, resolve } from "node:path";

import {
  deleteBranch,
  isMergedInto,
  isWorktreeDirty,
  pruneEmptyParents,
  removeWorktree,
  resolveRemoteDefault,
  submodulesWithLocalOnlyCommits,
} from "../git/index.ts";
import { HOOK_CLEAN, runHook, type HookContext } from "../hooks/run.ts";
import { silentProgress, type ProgressHandler } from "../progress.ts";
import { locateWorktree } from "./worktrees.ts";

export interface RemovePlan {
  /** The worktree name */
  name: string;
  /** Absolute path to the worktree */
  worktreePath: string;
  /** Branch name, or null when detached */
  branch: string | null;
  /**
   * Uncommitted or untracked files present, or the checkout could not be
   * inspected (unreadable status, submodule refs that cannot be walked).
   * Removal refuses without force in every case.
   */
  dirty: boolean;
  /**
   * Initialized submodules holding commits no remote has. A linked worktree's
   * submodule objects live under its own git directory, so removing it
   * deletes them; removal refuses without force.
   */
  localOnlySubmodules: string[];
  /** The main worktree, which cannot be removed */
  isMain: boolean;
  /** Locked with `git worktree lock`; removal refuses until it is unlocked */
  locked: boolean;
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
  hookEnv?: HookContext["baseEnv"];
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
    ...(await inspectForceBlockers(worktree.path)),
    isMain: worktree.path === root,
    locked: worktree.locked,
  };
}

type ForceBlockers = Pick<RemovePlan, "dirty" | "localOnlySubmodules">;

/** The conditions under which git, or wt on its behalf, refuses a removal without force. */
async function inspectForceBlockers(worktreePath: string): Promise<ForceBlockers> {
  // Nothing here throws: a checkout that cannot be inspected needs force, and
  // planning must still succeed so that force stays reachable.
  if (await isWorktreeDirty(worktreePath)) return { dirty: true, localOnlySubmodules: [] };
  const probe = await submodulesWithLocalOnlyCommits(worktreePath);
  if (!probe.ok) return { dirty: true, localOnlySubmodules: [] };
  return { dirty: false, localOnlySubmodules: probe.value };
}

/**
 * Why removing `name` needs force, phrased for an error or a prompt, or null
 * when git would accept the removal as is.
 */
export function forceReason(name: string, blockers: ForceBlockers): string | null {
  if (blockers.dirty) return `Worktree '${name}' has uncommitted or untracked changes`;
  if (blockers.localOnlySubmodules.length > 0) {
    const list = blockers.localOnlySubmodules.join(", ");
    return `Submodule ${list} in worktree '${name}' has commits no remote has, which removal would delete`;
  }
  return null;
}

/**
 * Run the clean hook, then remove the worktree and optionally its branch.
 *
 * Throws when the worktree is dirty or a submodule holds local-only commits
 * and `force` is not set, when it is the main worktree, or when it is locked.
 * Every refusal happens before the clean hook runs, so a removal git would
 * reject never tears down the environment; only a change made while the hook
 * runs can fail afterwards.
 */
export async function executeRemove(
  params: RemoveParams,
  progress: ProgressHandler = silentProgress,
): Promise<RemoveResult> {
  const { name, repoPath, force } = params;
  const { root, dir, worktree } = await locateWorktree(name, repoPath);

  if (params.expectedPath && resolve(worktree.path) !== resolve(params.expectedPath)) {
    throw new Error(`Worktree '${name}' resolved to an unexpected path: ${worktree.path}`);
  }

  if (worktree.path === root) {
    throw new Error("Refusing to remove the main worktree.");
  }
  if (worktree.locked) {
    throw new Error(lockedMessage(name, worktree.path));
  }
  if (!force) {
    const reason = forceReason(name, await inspectForceBlockers(worktree.path));
    if (reason) throw new Error(`${reason}. Use force to remove it anyway.`);
  }

  const hookRan = await runHook(
    HOOK_CLEAN,
    { root, name, worktreePath: worktree.path, branch: worktree.branch, baseEnv: params.hookEnv },
    progress,
  );

  progress.log(`Removing worktree '${name}'...`);
  await removeWorktree(root, worktree.path, force);
  await pruneEmptyParents(dirname(worktree.path), dir);

  const branchDeleted = await tryDeleteBranch(
    root,
    worktree.branch,
    params.deleteBranch,
    params.forceBranch ?? false,
    progress,
  );

  return { name, path: worktree.path, removed: true, branchDeleted, hookRan };
}

/** `git worktree remove` refuses a locked worktree even with --force; say what unlocks it. */
export function lockedMessage(name: string, worktreePath: string): string {
  return `Worktree '${name}' is locked. Run \`git worktree unlock ${worktreePath}\` first.`;
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
    // `git branch -d` only counts a branch as merged into its upstream or HEAD.
    // Branches from `wt add` start at the remote default with no upstream, and
    // HEAD in a bare root is the local main mirror, which may lag; so an
    // untouched branch can look unmerged. Judge it against the remote default.
    if (!force && (await mergedIntoRemoteDefault(root, branch))) {
      await deleteBranch(root, branch, true);
      progress.log(`Deleted branch '${branch}' (merged into the remote default branch)`);
      return true;
    }
    const message = err instanceof Error ? err.message : String(err);
    progress.warn(`Warning: could not delete branch '${branch}': ${message}`);
    return false;
  }
}

async function mergedIntoRemoteDefault(root: string, branch: string): Promise<boolean> {
  const remoteDefault = await resolveRemoteDefault(root);
  if (!remoteDefault) return false;
  return isMergedInto(root, branch, remoteDefault);
}
