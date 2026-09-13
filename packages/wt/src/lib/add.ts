import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  addWorktree,
  assertValidWorktreeName,
  branchExists,
  canonicalWorktreesDir,
  deleteBranch,
  getManagedWorktrees,
  getWorktreeName,
  listWorktrees,
  pathExists,
  resolveRepoRoot,
  type Worktree,
} from "../git/index.ts";
import { HOOK_INIT, runHook } from "../hooks/run.ts";
import { silentProgress, type ProgressHandler } from "../progress.ts";

/**
 * A branch that stands in the way of creating a worktree named after it.
 * `used-by-worktree` is fatal; `exists` is resolvable via `branchResolution`.
 */
export type BranchConflict =
  | { kind: "used-by-worktree"; worktreePath: string }
  | { kind: "exists" };

export interface AddPlan {
  /** The worktree name */
  name: string;
  /** Absolute path the worktree will be created at */
  worktreePath: string;
  /** Branch the worktree will use (named after the worktree) */
  branch: string;
  /** Present only when the branch already exists */
  branchConflict?: BranchConflict;
}

export interface AddParams {
  name: string;
  /** Any path inside the repository (bare or non-bare) */
  repoPath: string;
  /** Check out this existing branch instead of creating one named after the worktree */
  branch?: string;
  /** Required when planAdd reported a branchConflict of kind "exists" */
  branchResolution?: "use-existing" | "delete-and-create";
  /**
   * Base environment for the init hook (default: process.env). Use to provide
   * a resolved shell PATH when calling from a non-shell context (e.g. a GUI app).
   */
  hookEnv?: Record<string, string>;
}

export interface AddResult {
  name: string;
  path: string;
  branch: string;
  /** The worktree was created */
  created: boolean;
  /** init.wt.sh existed and succeeded */
  hookRan: boolean;
}

/**
 * Inspect the repository and report what creating `name` would involve.
 * No mutations — safe to call speculatively.
 */
export async function planAdd(params: { name: string; repoPath: string }): Promise<AddPlan> {
  const { name, worktreePath, branchConflict } = await inspectAdd(params.name, params.repoPath);
  return { name, worktreePath, branch: name, ...(branchConflict ? { branchConflict } : {}) };
}

/**
 * Create a worktree, then run the init hook.
 *
 * The worktree lands at `<worktreesDir>/<name>` on a branch named after it,
 * unless `branch` names an existing branch to check out instead.
 */
export async function executeAdd(
  params: AddParams,
  progress: ProgressHandler = silentProgress,
): Promise<AddResult> {
  const { name, repoPath } = params;
  const { root, worktreePath, branchConflict } = await inspectAdd(name, repoPath);

  const branch = await createWorktree(
    { root, sourceCwd: repoPath, worktreePath, name, branchConflict, params },
    progress,
  );

  progress.log(`Created worktree '${name}' [${branch}] at ${worktreePath}`);

  const hookRan = await runHook(
    HOOK_INIT,
    { root, name, worktreePath, branch, baseEnv: params.hookEnv },
    progress,
  );

  return { name, path: worktreePath, branch, created: true, hookRan };
}

interface AddContext {
  root: string;
  /** Invocation path whose HEAD is the base for a newly created branch. */
  sourceCwd: string;
  worktreePath: string;
  name: string;
  branchConflict?: BranchConflict;
  params: AddParams;
}

/** Create the worktree and return the branch it checked out. */
async function createWorktree(ctx: AddContext, progress: ProgressHandler): Promise<string> {
  const { root, sourceCwd, worktreePath, name, params } = ctx;
  await mkdir(dirname(worktreePath), { recursive: true });

  if (params.branch) {
    if (!(await branchExists(root, params.branch))) {
      throw new Error(`Branch '${params.branch}' does not exist.`);
    }
    await addWorktree(sourceCwd, worktreePath, { branch: params.branch });
    return params.branch;
  }

  const conflict = ctx.branchConflict;
  if (!conflict) {
    await addWorktree(sourceCwd, worktreePath, { newBranch: name });
    return name;
  }

  if (conflict.kind === "used-by-worktree") {
    throw new Error(`Branch '${name}' is already checked out at ${conflict.worktreePath}`);
  }
  if (!params.branchResolution) {
    throw new Error(
      `Branch '${name}' already exists. Provide branchResolution: "use-existing" or "delete-and-create".`,
    );
  }
  if (params.branchResolution === "use-existing") {
    await addWorktree(sourceCwd, worktreePath, { branch: name });
    return name;
  }

  progress.log(`Deleting existing branch '${name}'...`);
  await deleteBranch(root, name, true);
  await addWorktree(sourceCwd, worktreePath, { newBranch: name });
  return name;
}

/**
 * Shared preflight for plan and execute: validate the name, resolve paths,
 * reject names already in use, and classify any branch conflict.
 */
async function inspectAdd(
  name: string,
  repoPath: string,
): Promise<{ root: string; worktreePath: string; name: string; branchConflict?: BranchConflict }> {
  await assertValidWorktreeName(name);

  const root = await resolveRepoRoot(repoPath);
  const dir = await canonicalWorktreesDir(root);
  const worktreePath = join(dir, name);
  const worktrees = await listWorktrees(root);

  const taken = getManagedWorktrees(worktrees, dir).find(
    (wt) => wt.path === worktreePath || getWorktreeName(wt.path, dir) === name,
  );
  if (taken) {
    throw new Error(`Worktree '${name}' already exists at ${taken.path}`);
  }
  if (await pathExists(worktreePath)) {
    throw new Error(`Path already exists: ${worktreePath}`);
  }

  const branchConflict = await classifyBranchConflict(root, name, worktrees);
  return { root, worktreePath, name, ...(branchConflict ? { branchConflict } : {}) };
}

async function classifyBranchConflict(
  root: string,
  name: string,
  worktrees: Worktree[],
): Promise<BranchConflict | undefined> {
  if (!(await branchExists(root, name))) return undefined;

  const holder = worktrees.find((wt) => !wt.bare && wt.branch === name);
  if (holder) return { kind: "used-by-worktree", worktreePath: holder.path };
  return { kind: "exists" };
}
