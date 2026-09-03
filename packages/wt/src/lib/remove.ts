import { loadConfig, getWorktreesDir, type LoadedConfig } from "../config/loader.ts";
import { runHookScript } from "../hooks/run.ts";
import { getWorktreeStatus, type WorktreeStatus } from "../init/detect.ts";
import { computeAllEnvVars } from "../worktree/env.ts";
import {
  deleteBranch,
  findWorktreeByName,
  listWorktrees,
  removeWorktree,
} from "../worktree/git.ts";
import { getManagedWorktrees, getWorktreeName } from "../worktree/select.ts";
import { StateManager } from "../worktree/state.ts";
import { silentProgress, type ProgressHandler } from "./progress.ts";

// ── Types ──────────────────────────────────────────────────────────────

export interface RemovePlan {
  /** The resolved worktree name */
  name: string;
  /** Full path to the worktree */
  worktreePath: string;
  /** Branch name, or null if detached HEAD */
  branch: string | null;
  /** Dirty state details. Null if worktree is clean. */
  status: WorktreeStatus | null;
  /** Whether branch deletion is an applicable option */
  branchDeletionApplicable: boolean;
}

export interface RemoveParams {
  name: string;
  /** Whether to also delete the branch */
  deleteBranch: boolean;
  /** Force removal even with dirty state */
  force?: boolean;
  /** Bare repo root path — required, never derived from cwd */
  repoPath: string;
  /** Pre-loaded config to avoid redundant wt.yaml reads. */
  loadedConfig?: LoadedConfig;
  /** Base environment for hook execution (default: process.env). Use to provide resolved shell PATH when calling from a non-shell context (e.g., GUI app). */
  hookEnv?: Record<string, string | undefined>;
}

export interface RemoveResult {
  name: string;
  path: string;
  branchDeleted: boolean;
}

// ── Plan ───────────────────────────────────────────────────────────────

/**
 * Inspect worktree state before removal.
 * Returns dirty status and branch deletion applicability.
 * No mutations — safe to call speculatively.
 */
/**
 * @param params.loadedConfig - Pre-loaded config to avoid redundant wt.yaml reads.
 */
export async function planRemove(params: {
  name: string;
  repoPath: string;
  loadedConfig?: LoadedConfig;
}): Promise<RemovePlan> {
  const { name, repoPath } = params;
  const { config, rootDir } = params.loadedConfig ?? (await loadConfig(repoPath, { repoPath }));
  const worktreesDir = getWorktreesDir({ config, rootDir, configPath: "" });
  const worktrees = await listWorktrees(rootDir);
  const managed = getManagedWorktrees(worktrees, worktreesDir);

  const worktree = findWorktreeByName(worktrees, name, worktreesDir);
  if (!worktree) {
    const managedNames = managed.map((wt) => getWorktreeName(wt.path, worktreesDir));
    if (managedNames.length > 0) {
      throw new Error(
        `Worktree '${name}' not found.\n\nAvailable worktrees:\n  ${managedNames.join("\n  ")}`,
      );
    }
    throw new Error(`Worktree '${name}' not found. No worktrees exist yet.`);
  }

  const rawStatus = await getWorktreeStatus(worktree.path);
  const hasIssues = hasStatusIssues(rawStatus);
  const branchDeletionApplicable = config.auto_branch && worktree.branch === name;

  return {
    name,
    worktreePath: worktree.path,
    branch: worktree.branch,
    status: hasIssues ? rawStatus : null,
    branchDeletionApplicable,
  };
}

// ── Execute ────────────────────────────────────────────────────────────

/**
 * Remove a worktree with all resolved decisions.
 * Throws if worktree has dirty state and force is not set.
 */
export async function executeRemove(
  params: RemoveParams,
  progress: ProgressHandler = silentProgress,
): Promise<RemoveResult> {
  const { name, repoPath } = params;
  const { config, rootDir } = params.loadedConfig ?? (await loadConfig(repoPath, { repoPath }));
  const worktreesDir = getWorktreesDir({ config, rootDir, configPath: "" });
  const worktrees = await listWorktrees(rootDir);
  const worktree = findWorktreeByName(worktrees, name, worktreesDir);

  if (!worktree) {
    throw new Error(`Worktree '${name}' not found.`);
  }

  const forceRemove = params.force ?? false;

  // Safety check: if not forced, verify clean state
  if (!forceRemove) {
    const status = await getWorktreeStatus(worktree.path);
    if (hasStatusIssues(status)) {
      throw new Error(
        `Worktree '${name}' has local changes. Use force to remove, or resolve changes first.`,
      );
    }
  }

  const state = new StateManager(rootDir);
  const index = await state.getIndex(name);

  if (index !== undefined) {
    const env = computeAllEnvVars(name, worktree.path, rootDir, index, config);
    await runCleanHook(progress, config, worktree.path, env, forceRemove, params.hookEnv);
  } else {
    progress.warn(`Warning: No state entry for '${name}', skipping clean hook`);
  }

  progress.log(`Removing worktree '${name}'...`);
  await removeWorktree(rootDir, worktree.path, forceRemove);
  await freeStateIndex(progress, state, name);

  const branchDeleted = await tryDeleteBranch(
    progress,
    rootDir,
    worktree.branch,
    params.deleteBranch,
    forceRemove,
  );

  return { name, path: worktree.path, branchDeleted };
}

// ── Internal helpers ───────────────────────────────────────────────────

function hasStatusIssues(status: WorktreeStatus): boolean {
  const hasUnpushedWork = status.aheadCount === null || status.aheadCount > 0;
  return (
    status.untrackedFiles.length > 0 ||
    status.stagedCount > 0 ||
    status.unstagedCount > 0 ||
    hasUnpushedWork
  );
}

type ConfigType = Awaited<ReturnType<typeof loadConfig>>["config"];

async function runCleanHook(
  progress: ProgressHandler,
  config: ConfigType,
  worktreePath: string,
  env: Record<string, string>,
  force?: boolean,
  hookEnv?: Record<string, string | undefined>,
): Promise<void> {
  if (!config.hooks?.clean?.run) return;

  progress.log("Running clean hook...");
  try {
    const result = await runHookScript(config.hooks.clean.run, worktreePath, env, hookEnv);
    if (result.output) {
      progress.log(result.output);
    }
  } catch (err) {
    if (!force) throw err;
    progress.warn("  Warning: Clean hook failed, continuing with force");
  }
}

async function freeStateIndex(
  progress: ProgressHandler,
  state: StateManager,
  name: string,
): Promise<void> {
  try {
    await state.freeIndex(name);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("not found in state")) {
      progress.warn(`  Warning: Failed to free state index: ${message}`);
    }
  }
}

async function tryDeleteBranch(
  progress: ProgressHandler,
  rootDir: string,
  branch: string | null,
  shouldDelete: boolean,
  force?: boolean,
): Promise<boolean> {
  if (!shouldDelete || !branch) return false;

  progress.log(`Deleting branch '${branch}'...`);
  try {
    await deleteBranch(rootDir, branch, force);
    return true;
  } catch (err) {
    progress.warn(`  Warning: Could not delete branch '${branch}': ${err}`);
    return false;
  }
}
