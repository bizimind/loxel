import {
  canonicalWorktreesDir,
  getManagedWorktrees,
  getWorktreeName,
  listWorktrees,
  resolveRepoRoot,
  worktreeContaining,
  type Worktree,
} from "../git/index.ts";

/** A worktree managed by wt (living under the worktrees directory). */
export interface ManagedWorktree {
  /** Directory name relative to the worktrees dir (e.g. "feat/add-voice-input") */
  name: string;
  /** Absolute path to the worktree */
  path: string;
  /** Git branch name, or null if detached HEAD */
  branch: string | null;
  /** HEAD commit hash */
  head: string;
}

/**
 * The absolute worktrees directory for a repository: `$WT_DIR`, or
 * `<repoRoot>/.worktrees`.
 *
 * @param repoPath - Any path inside the repository (bare or non-bare)
 */
export async function resolveWorktreesDir(repoPath: string): Promise<string> {
  return canonicalWorktreesDir(await resolveRepoRoot(repoPath));
}

/**
 * List the worktrees wt manages, named by their path under the worktrees dir.
 *
 * @param repoPath - Any path inside the repository (bare or non-bare)
 */
export async function listManagedWorktrees(repoPath: string): Promise<ManagedWorktree[]> {
  const root = await resolveRepoRoot(repoPath);
  const dir = await canonicalWorktreesDir(root);
  const managed = getManagedWorktrees(await listWorktrees(root), dir);

  return managed.map((wt) => ({
    name: getWorktreeName(wt.path, dir),
    path: wt.path,
    branch: wt.branch,
    head: wt.head,
  }));
}

/** A worktree resolved by name, with the repository paths it was found through. */
export interface LocatedWorktree {
  /** Repository root: the main worktree's top level, or the git dir when bare */
  root: string;
  /** Absolute worktrees directory the name was resolved against */
  dir: string;
  worktree: Worktree;
}

/**
 * Resolve a worktree by name, listing the available names in the error.
 *
 * Shared by every operation that acts on an existing worktree, so a bad name
 * fails the same way everywhere.
 *
 * @param repoPath - Any path inside the repository (bare or non-bare)
 */
export async function locateWorktree(name: string, repoPath: string): Promise<LocatedWorktree> {
  const root = await resolveRepoRoot(repoPath);
  const dir = await canonicalWorktreesDir(root);
  const worktrees = await listWorktrees(root);

  const target = `${dir}/${name}`;
  const worktree = getManagedWorktrees(worktrees, dir).find(
    (candidate) => candidate.path === target,
  );
  if (worktree) return { root, dir, worktree };

  const available = getManagedWorktrees(worktrees, dir).map((wt) => getWorktreeName(wt.path, dir));
  if (available.length === 0) {
    throw new Error(`Worktree '${name}' not found. No worktrees exist yet.`);
  }
  throw new Error(
    `Worktree '${name}' not found.\n\nAvailable worktrees:\n  ${available.join("\n  ")}`,
  );
}

/**
 * The managed worktree containing `dirPath`, or null when it is outside them
 * all — the main worktree of a non-bare repo included, since it does not live
 * under the worktrees directory.
 *
 * @param repoPath - Any path inside the repository (bare or non-bare)
 */
export async function currentManagedWorktree(
  repoPath: string,
  dirPath: string,
): Promise<ManagedWorktree | null> {
  const root = await resolveRepoRoot(repoPath);
  const dir = await canonicalWorktreesDir(root);
  const managed = getManagedWorktrees(await listWorktrees(root), dir);

  const current = worktreeContaining(managed, dirPath);
  if (!current) return null;

  return {
    name: getWorktreeName(current.path, dir),
    path: current.path,
    branch: current.branch,
    head: current.head,
  };
}
