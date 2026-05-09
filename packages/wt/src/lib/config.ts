import { getWorktreesDir, loadConfig } from "../config/loader.ts";
import { listWorktrees } from "../worktree/git.ts";
import { getManagedWorktrees, getWorktreeName } from "../worktree/select.ts";

/**
 * Resolve the absolute worktrees directory for a bare repo.
 * Loads wt.yaml config and computes the full path.
 *
 * @param repoPath - Bare repo root path
 * @returns Absolute path to the worktrees directory
 */
export async function resolveWorktreesDir(repoPath: string): Promise<string> {
  const { config, rootDir } = await loadConfig(repoPath, { repoPath });
  return getWorktreesDir({ config, rootDir, configPath: "" });
}

/** A worktree managed by wt (under the configured worktrees_dir). */
export interface ManagedWorktree {
  /** Directory name relative to worktreesDir (e.g., "feat/add-voice-input") */
  name: string;
  /** Absolute path to the worktree */
  path: string;
  /** Git branch name, or null if detached HEAD */
  branch: string | null;
  /** HEAD commit hash */
  head: string;
}

/**
 * List worktrees managed by wt.
 * Loads config, lists git worktrees, filters to those under worktreesDir,
 * and returns entries with the wt directory-based name.
 *
 * @param repoPath - Bare repo root path
 * @returns Managed worktrees with wt names
 */
export async function listManagedWorktrees(repoPath: string): Promise<ManagedWorktree[]> {
  const { config, rootDir } = await loadConfig(repoPath, { repoPath });
  const worktreesDir = getWorktreesDir({ config, rootDir, configPath: "" });
  const allWorktrees = await listWorktrees(rootDir);
  const managed = getManagedWorktrees(allWorktrees, worktreesDir);

  return managed.map((wt) => ({
    name: getWorktreeName(wt.path, worktreesDir),
    path: wt.path,
    branch: wt.branch,
    head: wt.head,
  }));
}
