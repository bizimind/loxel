import { join } from "node:path";

import {
  assertValidWorktreeName,
  branchExists,
  DETACHED,
  getWorktreeName,
  moveWorktree,
  pathExists,
  renameBranch,
  type Worktree,
} from "../git/index.ts";
import { HOOK_RENAME, runHook } from "../hooks/run.ts";
import { silentProgress, type ProgressHandler } from "../progress.ts";
import { locateWorktree } from "./worktrees.ts";

/**
 * Why the branch stays put while the directory moves.
 *
 * `wt add x` creates branch `x`, so name and branch are normally in sync and
 * should stay that way. Once they have diverged — an existing branch adopted
 * via `add -b` — renaming the directory must not silently rename an unrelated
 * branch.
 */
export type BranchSkipReason = "keep-branch" | "detached" | "diverged";

export interface MovePlan {
  /** Canonical name of the worktree being renamed */
  oldName: string;
  /** Absolute path it currently lives at */
  oldPath: string;
  /** Its branch, or null when detached */
  oldBranch: string | null;
  /** The new worktree name */
  name: string;
  /** Absolute path the worktree will move to */
  worktreePath: string;
  /** Branch to rename to, or null to leave the branch alone */
  newBranch: string | null;
  /** Present only when `newBranch` is null, explaining why */
  branchSkipReason?: BranchSkipReason;
  /** The main worktree, which cannot be renamed */
  isMain: boolean;
}

export interface MoveParams {
  /** Worktree to rename */
  oldName: string;
  /** New worktree name */
  name: string;
  /** Any path inside the repository (bare or non-bare) */
  repoPath: string;
  /** Rename the branch to this instead of to the new worktree name */
  branch?: string;
  /** Never touch the branch, whatever it is called */
  keepBranch?: boolean;
  /** Move a locked worktree */
  force?: boolean;
  /**
   * Base environment for the rename hook (default: process.env). Use to provide
   * a resolved shell PATH when calling from a non-shell context (e.g. a GUI app).
   */
  hookEnv?: Record<string, string>;
}

/** The subset of `MoveParams` that decides what a rename would do. */
export type MoveTarget = Pick<
  MoveParams,
  "oldName" | "name" | "repoPath" | "branch" | "keepBranch"
>;

export interface MoveResult {
  name: string;
  path: string;
  /** The branch the worktree ended up on, or `(detached)` */
  branch: string;
  oldName: string;
  oldPath: string;
  /** The branch it started on, or `(detached)` */
  oldBranch: string;
  /** The directory was moved */
  moved: true;
  /** The branch was renamed too */
  branchRenamed: boolean;
}

/**
 * Inspect the repository and report what renaming a worktree would involve.
 * No mutations — safe to call speculatively.
 *
 * Throws for anything that makes the rename impossible, so a rejected rename
 * never leaves a half-applied state.
 */
export async function planMove(params: MoveTarget): Promise<MovePlan> {
  return (await inspectMove(params)).plan;
}

/**
 * Move a worktree's directory, rename its branch to match, then run the
 * rename hook at the new path.
 *
 * The move is the only irreversible step: a failed branch rename or a failed
 * hook is reported through `progress.warn` and reflected in the result.
 */
export async function executeMove(
  params: MoveParams,
  progress: ProgressHandler = silentProgress,
): Promise<MoveResult> {
  const { root, plan } = await inspectMove(params);

  if (plan.isMain) {
    throw new Error("Refusing to rename the main worktree.");
  }
  if (plan.branchSkipReason === "diverged" && plan.oldBranch) {
    progress.log(
      `Branch '${plan.oldBranch}' differs from worktree name '${plan.oldName}'; leaving it alone (use --branch to rename it)`,
    );
  }

  const force = params.force ?? false;
  await moveWorktree(root, plan.oldPath, plan.worktreePath, force);
  progress.log(`Moved ${plan.oldPath} -> ${plan.worktreePath}`);

  const { branch, branchRenamed } = await tryRenameBranch(root, plan, force, progress);

  await runHook(
    HOOK_RENAME,
    {
      root,
      name: plan.name,
      worktreePath: plan.worktreePath,
      branch,
      baseEnv: params.hookEnv,
      extraEnv: {
        WT_OLD_NAME: plan.oldName,
        WT_OLD_PATH: plan.oldPath,
        WT_OLD_BRANCH: plan.oldBranch ?? DETACHED,
      },
    },
    progress,
  );

  return {
    name: plan.name,
    path: plan.worktreePath,
    branch: branch ?? DETACHED,
    oldName: plan.oldName,
    oldPath: plan.oldPath,
    oldBranch: plan.oldBranch ?? DETACHED,
    moved: true,
    branchRenamed,
  };
}

/**
 * The whole preflight, shared by plan and execute: resolve the worktree,
 * validate the new name, resolve the destination, and reject a taken branch
 * name — all before anything is touched.
 */
async function inspectMove(params: MoveTarget): Promise<{ root: string; plan: MovePlan }> {
  const { root, dir, worktree } = await locateWorktree(params.oldName, params.repoPath);
  const oldName = getWorktreeName(worktree.path, dir);

  await assertValidWorktreeName(params.name);

  const worktreePath = join(dir, params.name);
  if (worktreePath === worktree.path) {
    throw new Error(`Worktree '${oldName}' is already at ${worktreePath}`);
  }
  if (await pathExists(worktreePath)) {
    throw new Error(`Path already exists: ${worktreePath}`);
  }

  const { newBranch, branchSkipReason } = planBranch(params, worktree, oldName);
  if (newBranch && newBranch !== worktree.branch && (await branchExists(root, newBranch))) {
    throw new Error(`Branch '${newBranch}' already exists.`);
  }

  return {
    root,
    plan: {
      oldName,
      oldPath: worktree.path,
      oldBranch: worktree.branch,
      name: params.name,
      worktreePath,
      newBranch,
      ...(branchSkipReason ? { branchSkipReason } : {}),
      isMain: worktree.path === root,
    },
  };
}

/** Decide the branch rename target, or why there isn't one. */
function planBranch(
  params: MoveTarget,
  worktree: Worktree,
  oldName: string,
): { newBranch: string | null; branchSkipReason?: BranchSkipReason } {
  if (params.keepBranch) return { newBranch: null, branchSkipReason: "keep-branch" };
  // A detached worktree has no branch to rename, `--branch` notwithstanding.
  if (!worktree.branch) return { newBranch: null, branchSkipReason: "detached" };
  if (params.branch) return { newBranch: params.branch };
  if (worktree.branch !== oldName) return { newBranch: null, branchSkipReason: "diverged" };
  return { newBranch: params.name };
}

/**
 * Rename the branch after a successful move.
 *
 * The directory has already moved by this point and the rename is recoverable
 * by hand, so a failure warns rather than throwing (as `tryDeleteBranch` does
 * in `remove`).
 */
async function tryRenameBranch(
  root: string,
  plan: MovePlan,
  force: boolean,
  progress: ProgressHandler,
): Promise<{ branch: string | null; branchRenamed: boolean }> {
  const { newBranch, oldBranch } = plan;
  if (!newBranch || !oldBranch || newBranch === oldBranch) {
    return { branch: oldBranch, branchRenamed: false };
  }

  try {
    await renameBranch(root, oldBranch, newBranch, force);
    progress.log(`Renamed branch '${oldBranch}' -> '${newBranch}'`);
    return { branch: newBranch, branchRenamed: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    progress.warn(`Warning: could not rename branch '${oldBranch}': ${message}`);
    return { branch: oldBranch, branchRenamed: false };
  }
}
