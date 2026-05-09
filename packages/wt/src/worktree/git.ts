import { wrapError } from "@bizimind/cli-common";
import { $ } from "bun";

import { hasUncommittedChanges } from "../init/detect.ts";

export interface Worktree {
  /** Absolute path to the worktree */
  path: string;
  /** HEAD commit hash */
  head: string;
  /** Branch name (without refs/heads/) or null if detached */
  branch: string | null;
  /** Whether this is the bare repo itself */
  bare: boolean;
}

/**
 * Parse git worktree list --porcelain output.
 * Format:
 * worktree /path/to/worktree
 * HEAD abc123...
 * branch refs/heads/main
 * <blank line>
 */
export function parseWorktreeList(output: string): Worktree[] {
  const worktrees: Worktree[] = [];
  const blocks = output.trim().split("\n\n");

  for (const block of blocks) {
    if (!block.trim()) continue;

    const lines = block.split("\n");
    let path = "";
    let head = "";
    let branch: string | null = null;
    let bare = false;

    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        path = line.slice("worktree ".length);
      } else if (line.startsWith("HEAD ")) {
        head = line.slice("HEAD ".length);
      } else if (line.startsWith("branch ")) {
        const fullBranch = line.slice("branch ".length);
        // Strip refs/heads/ prefix
        branch = fullBranch.replace(/^refs\/heads\//, "");
      } else if (line === "bare") {
        bare = true;
      } else if (line === "detached") {
        branch = null;
      }
    }

    if (path) {
      worktrees.push({ path, head, branch, bare });
    }
  }

  return worktrees;
}

/**
 * List all worktrees in the repository.
 *
 * @param cwd - Directory to run git command from
 * @returns Array of worktree info
 */
export async function listWorktrees(cwd: string): Promise<Worktree[]> {
  try {
    const result = await $`git -C ${cwd} worktree list --porcelain`.text();
    return parseWorktreeList(result);
  } catch (err) {
    throw wrapError("Failed to list worktrees", err);
  }
}

/**
 * Check if the repository at cwd is a bare repo.
 */
export async function isBareRepo(cwd: string): Promise<boolean> {
  try {
    const result = await $`git -C ${cwd} rev-parse --is-bare-repository`.text();
    return result.trim() === "true";
  } catch (err) {
    throw wrapError("Failed to check if repo is bare", err);
  }
}

/**
 * Get the root directory of the git repository.
 */
export async function getGitRoot(cwd: string): Promise<string> {
  try {
    // For bare repos, use --git-dir, for regular repos use --show-toplevel
    const isBare = await isBareRepo(cwd);
    if (isBare) {
      const result = await $`git -C ${cwd} rev-parse --git-dir`.text();
      return result.trim();
    }
    const result = await $`git -C ${cwd} rev-parse --show-toplevel`.text();
    return result.trim();
  } catch (err) {
    throw wrapError("Failed to get git root", err);
  }
}

/**
 * Check if a branch exists.
 */
export async function branchExists(cwd: string, branch: string): Promise<boolean> {
  try {
    await $`git -C ${cwd} rev-parse --verify refs/heads/${branch}`.quiet();
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a remote exists.
 */
export async function remoteExists(cwd: string, remote: string): Promise<boolean> {
  try {
    const result = await $`git -C ${cwd} remote`.text();
    const remotes = result.trim().split("\n").filter(Boolean);
    return remotes.includes(remote);
  } catch {
    return false;
  }
}

/**
 * Check if a remote tracking branch exists (e.g., origin/main).
 */
export async function remoteBranchExists(
  cwd: string,
  remote: string,
  branch: string,
): Promise<boolean> {
  try {
    await $`git -C ${cwd} rev-parse --verify refs/remotes/${remote}/${branch}`.quiet();
    return true;
  } catch {
    return false;
  }
}

/**
 * Add a new worktree.
 *
 * @param cwd - Git repository root
 * @param path - Path for the new worktree
 * @param options - Worktree creation options
 */
export async function addWorktree(
  cwd: string,
  path: string,
  options: {
    /** Create new branch with this name */
    newBranch?: string;
    /** Use existing branch */
    branch?: string;
    /** Base branch for new branch (default: HEAD) */
    baseBranch?: string;
  } = {},
): Promise<void> {
  try {
    if (options.newBranch) {
      // Create new branch based on baseBranch or HEAD
      const base = options.baseBranch ?? "HEAD";
      await $`git -C ${cwd} worktree add -b ${options.newBranch} ${path} ${base}`.quiet();
    } else if (options.branch) {
      // Use existing branch
      await $`git -C ${cwd} worktree add ${path} ${options.branch}`.quiet();
    } else {
      // Detached HEAD at current HEAD
      await $`git -C ${cwd} worktree add --detach ${path}`.quiet();
    }
  } catch (err) {
    throw wrapError(`Failed to add worktree at ${path}`, err);
  }
}

/**
 * Remove a worktree.
 *
 * @param cwd - Git repository root
 * @param path - Path of the worktree to remove
 * @param force - Force removal even with uncommitted changes
 */
export async function removeWorktree(cwd: string, path: string, force = false): Promise<void> {
  try {
    if (force) {
      await $`git -C ${cwd} worktree remove --force ${path}`.quiet();
    } else {
      await $`git -C ${cwd} worktree remove ${path}`.quiet();
    }
  } catch (err) {
    throw wrapError(`Failed to remove worktree at ${path}`, err);
  }
}

/**
 * Delete a branch.
 *
 * @param cwd - Git repository root
 * @param branch - Branch name to delete
 * @param force - Force deletion even if not merged
 */
export async function deleteBranch(cwd: string, branch: string, force = false): Promise<void> {
  try {
    const flag = force ? "-D" : "-d";
    await $`git -C ${cwd} branch ${flag} ${branch}`.quiet();
  } catch (err) {
    throw wrapError(`Failed to delete branch ${branch}`, err);
  }
}

/**
 * Find a worktree by name.
 * Matches the name against the path suffix (supports names with slashes like "feat/foo").
 */
export function findWorktreeByName(worktrees: Worktree[], name: string): Worktree | undefined {
  return worktrees.find((wt) => wt.path.endsWith(`/${name}`));
}

/**
 * Fetch latest from a remote for a specific branch.
 * Updates the remote tracking ref (e.g., origin/main).
 * @returns true if fetch succeeded, false if it failed (non-fatal)
 */
export async function fetchBranch(cwd: string, remote: string, branch: string): Promise<boolean> {
  try {
    await $`git -C ${cwd} fetch ${remote} ${branch}`.quiet();
    return true;
  } catch {
    // Fetch may fail if remote doesn't exist or branch doesn't exist on remote
    // This is non-fatal - caller can proceed with whatever local state exists
    return false;
  }
}

/**
 * Check if a worktree is synced with its upstream.
 * Returns true if:
 * - No uncommitted changes (staged, unstaged, untracked)
 * - AND either: no upstream tracking OR (ahead=0 AND behind=0)
 */
export async function isSynced(worktreePath: string): Promise<boolean> {
  // Check for uncommitted changes
  if (await hasUncommittedChanges(worktreePath)) {
    return false;
  }

  // Check ahead/behind status with upstream
  try {
    const result =
      await $`git -C ${worktreePath} rev-list --left-right --count HEAD...@{upstream}`.text();
    const [ahead, behind] = result.trim().split(/\s+/).map(Number);
    return ahead === 0 && behind === 0;
  } catch {
    // No upstream tracking - considered synced if no uncommitted changes
    return true;
  }
}
