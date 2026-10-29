import { join } from "node:path";

import {
  addWorktree,
  assertValidWorktreeName,
  branchExists,
  canonicalWorktreesDir,
  deleteBranch,
  excludeWorktreesDir,
  getManagedWorktrees,
  getWorktreeName,
  listWorktrees,
  pathExists,
  resolveCommit,
  resolveRemoteDefault,
  resolveRepoRoot,
  type Worktree,
  type WorktreeMeta,
} from "../git/index.ts";
import { HOOK_INIT, runHook, type HookContext } from "../hooks/run.ts";
import { silentProgress, type ProgressHandler } from "../progress.ts";
import {
  initWorktreeMeta,
  isWorktreeMetadataEnabled,
  METADATA_OFF_MESSAGE,
  writableMeta,
} from "./meta.ts";

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
  /**
   * Start a newly created branch from this ref or commit instead of the
   * default (the remote default branch as last fetched, else HEAD). Ignored
   * when an existing branch is checked out.
   */
  base?: string;
  /**
   * Metadata to store on the new worktree (see `setWorktreeMeta`). Needs
   * metadata on; `wt-*` keys are reserved.
   */
  meta?: WorktreeMeta;
  /** Required when planAdd reported a branchConflict of kind "exists" */
  branchResolution?: "use-existing" | "delete-and-create";
  /**
   * Base environment for the init hook (default: process.env). Use to provide
   * a resolved shell PATH when calling from a non-shell context (e.g. a GUI app).
   */
  hookEnv?: HookContext["baseEnv"];
}

export interface AddResult {
  name: string;
  path: string;
  branch: string;
  /** The worktree was created */
  created: boolean;
  /**
   * The ref the new branch was started from (`origin/main`, `HEAD`, or the
   * explicit `base`). Absent when an existing branch was checked out.
   */
  base?: string;
  /** init.wt.sh existed and succeeded */
  hookRan: boolean;
  /** The new worktree's metadata, its `wt-id` included; empty while metadata is off */
  meta: WorktreeMeta;
}

/**
 * Inspect the repository and report what creating `name` would involve.
 * No mutations — safe to call speculatively.
 */
export async function planAdd(
  params: Pick<AddParams, "name" | "repoPath" | "meta">,
): Promise<AddPlan> {
  const { name, worktreePath, branchConflict } = await inspectAdd(params);
  return { name, worktreePath, branch: name, ...(branchConflict ? { branchConflict } : {}) };
}

/**
 * Create a worktree, then run the init hook.
 *
 * The worktree lands at `<worktreesDir>/<name>` on a branch named after it,
 * unless `branch` names an existing branch to check out instead. While
 * metadata is on, the worktree gets a `wt-id` and `meta`, written before the
 * hook runs so the hook can read them.
 */
export async function executeAdd(
  params: AddParams,
  progress: ProgressHandler = silentProgress,
): Promise<AddResult> {
  const { name, repoPath } = params;
  const {
    root,
    dir,
    worktreePath,
    branchConflict,
    worktrees,
    meta: values,
  } = await inspectAdd(params);
  await excludeWorktreesDir(root, dir);

  const { branch, base } = await createWorktree(
    { root, sourceCwd: repoPath, worktreePath, name, branchConflict, worktrees, params },
    progress,
  );

  const from = base ? ` from ${base}` : "";
  progress.log(`Created worktree '${name}' [${branch}]${from} at ${worktreePath}`);

  let meta: WorktreeMeta;
  try {
    meta = await initWorktreeMeta(root, worktreePath, values);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Created worktree '${name}', but could not write its metadata: ${reason}`, {
      cause: error,
    });
  }

  const hookRan = await runHook(
    HOOK_INIT,
    { root, name, worktreePath, branch, baseEnv: params.hookEnv },
    progress,
  );

  return {
    name,
    path: worktreePath,
    branch,
    created: true,
    ...(base ? { base } : {}),
    hookRan,
    meta,
  };
}

interface AddContext {
  root: string;
  /** Invocation path; its HEAD is the base for a new branch when no remote default exists. */
  sourceCwd: string;
  worktreePath: string;
  name: string;
  branchConflict?: BranchConflict;
  /** Every worktree git knows about, for detecting an already checked-out `-b` branch */
  worktrees: Worktree[];
  params: AddParams;
}

/**
 * Create the worktree and return the branch it checked out, plus the start
 * point when that branch was newly created.
 */
async function createWorktree(
  ctx: AddContext,
  progress: ProgressHandler,
): Promise<{ branch: string; base?: string }> {
  // No mkdir here: `git worktree add` creates leading directories itself, and creating them
  // early would leave empty parents behind when a check below rejects the add.
  const { root, sourceCwd, worktreePath, name, params } = ctx;

  if (params.branch) {
    const conflict = await classifyBranchConflict(root, params.branch, ctx.worktrees);
    if (!conflict) {
      throw new Error(`Branch '${params.branch}' does not exist.`);
    }
    if (conflict.kind === "used-by-worktree") {
      throw new Error(
        `Branch '${params.branch}' is already checked out at ${conflict.worktreePath}`,
      );
    }
    await addWorktree(sourceCwd, worktreePath, { branch: params.branch });
    return { branch: params.branch };
  }

  const conflict = ctx.branchConflict;
  if (!conflict) {
    const base = await resolveBase(root, sourceCwd, params.base);
    await addWorktree(sourceCwd, worktreePath, { newBranch: name, startPoint: base.commit });
    return { branch: name, base: base.name };
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
    return { branch: name };
  }

  // Pin the base to a commit before the force-delete: a typo in --base must
  // not cost an unmerged branch, and a base naming the branch itself
  // (`--base <name>~1`) must still resolve once that branch is gone.
  const base = await resolveBase(root, sourceCwd, params.base);
  progress.log(`Deleting existing branch '${name}'...`);
  await deleteBranch(root, name, true);
  await addWorktree(sourceCwd, worktreePath, { newBranch: name, startPoint: base.commit });
  return { branch: name, base: base.name };
}

/**
 * Where a new branch starts: the explicit base, else the remote default branch
 * as last fetched (`origin/main`), else HEAD. Nothing here touches the network;
 * fetching stays the user's explicit act, as with git itself. A repo without a
 * remote default (local-only, or a bare clone that never fetched with a
 * refspec) simply behaves like `git worktree add`.
 *
 * Returns the human-readable name for reporting and the commit it pins to.
 * Resolution happens in `sourceCwd` (where the worktree is added, so `HEAD`
 * means the same thing) before anything is mutated, and the commit, not the
 * name, is what `git worktree add` receives: the name may stop resolving once
 * the branch it refers to is deleted.
 */
async function resolveBase(
  root: string,
  sourceCwd: string,
  explicit: string | undefined,
): Promise<{ name: string; commit: string }> {
  const name = explicit ?? (await resolveRemoteDefault(root)) ?? "HEAD";
  const commit = await resolveCommit(sourceCwd, name);
  if (!commit) throw new Error(`Base '${name}' does not resolve to a commit.`);
  return { name, commit };
}

/**
 * Shared preflight for plan and execute: validate the name and metadata,
 * resolve paths, reject names already in use, and classify any branch
 * conflict.
 */
async function inspectAdd({
  name,
  repoPath,
  meta = {},
}: Pick<AddParams, "name" | "repoPath" | "meta">): Promise<{
  root: string;
  /** Canonical worktrees directory */
  dir: string;
  worktreePath: string;
  name: string;
  branchConflict?: BranchConflict;
  worktrees: Worktree[];
  /** The metadata to write, keys normalized */
  meta: WorktreeMeta;
}> {
  const root = await resolveRepoRoot(repoPath);
  await assertValidWorktreeName(name, root);

  const values = writableMeta(meta);
  if (Object.keys(values).length > 0 && !(await isWorktreeMetadataEnabled(root))) {
    throw new Error(METADATA_OFF_MESSAGE);
  }

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
  return {
    root,
    dir,
    worktreePath,
    name,
    worktrees,
    meta: values,
    ...(branchConflict ? { branchConflict } : {}),
  };
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
