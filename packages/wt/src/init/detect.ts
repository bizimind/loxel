import { $ } from "bun";

export type RepoType = "empty" | "bare" | "regular" | "worktree";

/**
 * Known editors with their command and display name.
 */
export const KNOWN_EDITORS = [
  { cmd: "code", name: "VS Code" },
  { cmd: "cursor", name: "Cursor" },
  { cmd: "zed", name: "Zed" },
  { cmd: "idea", name: "IntelliJ IDEA" },
  { cmd: "webstorm", name: "WebStorm" },
  { cmd: "goland", name: "GoLand" },
  { cmd: "pycharm", name: "PyCharm" },
  { cmd: "fleet", name: "JetBrains Fleet" },
  { cmd: "nvim", name: "Neovim" },
  { cmd: "vim", name: "Vim" },
  { cmd: "emacs", name: "Emacs" },
  { cmd: "subl", name: "Sublime Text" },
  { cmd: "atom", name: "Atom" },
  { cmd: "hx", name: "Helix" },
] as const;

/**
 * Detect the type of repository at the given path.
 */
export async function detectRepoType(cwd: string): Promise<RepoType> {
  // Check if it's a git directory at all
  try {
    await $`git -C ${cwd} rev-parse --git-dir`.quiet();
  } catch {
    // Not a git repo - check if directory is empty (or nearly empty)
    const entries = await Array.fromAsync(new Bun.Glob("*").scan({ cwd, dot: true }));
    // Filter out common non-repo files that might exist in an "empty" directory
    const significantEntries = entries.filter(
      (e) => !e.startsWith(".DS_Store") && e !== ".gitignore",
    );
    return significantEntries.length === 0 ? "empty" : "empty";
  }

  // Check if we're inside a worktree
  try {
    const gitDir = (await $`git -C ${cwd} rev-parse --git-dir`.text()).trim();
    // If .git is a file (not directory), we're in a worktree
    const gitPath = `${cwd}/${gitDir}`;
    const stat = await Bun.file(gitPath)
      .stat()
      .catch(() => null);
    if (stat && !stat.isDirectory()) {
      return "worktree";
    }
    // Also check if git-dir points outside cwd (linked worktree)
    if (gitDir.includes(".git/worktrees/")) {
      return "worktree";
    }
  } catch {
    // Ignore errors
  }

  // Check if it's a bare repo
  try {
    const isBare = (await $`git -C ${cwd} rev-parse --is-bare-repository`.text()).trim();
    if (isBare === "true") {
      return "bare";
    }
  } catch {
    // Ignore errors
  }

  return "regular";
}

/**
 * Get the bare repo root if we're inside a worktree.
 * Returns null if not in a worktree.
 */
export async function getBareRepoRoot(cwd: string): Promise<string | null> {
  try {
    const gitDir = (await $`git -C ${cwd} rev-parse --git-dir`.text()).trim();

    // Check if gitDir contains worktrees path pattern
    const worktreesMatch = gitDir.match(/(.*)\/\.git\/worktrees\//);
    if (worktreesMatch && worktreesMatch[1]) {
      return worktreesMatch[1];
    }

    // For bare repos with worktrees, the pattern is different
    const bareWorktreesMatch = gitDir.match(/(.*?)\/worktrees\//);
    if (bareWorktreesMatch && bareWorktreesMatch[1]) {
      return bareWorktreesMatch[1];
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Check if a command exists in PATH.
 */
async function commandExists(cmd: string): Promise<boolean> {
  try {
    await $`which ${cmd}`.quiet();
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect which known editors are available on the system.
 */
export async function detectEditors(): Promise<Array<{ cmd: string; name: string }>> {
  const results = await Promise.all(
    KNOWN_EDITORS.map(async (editor) => ({ ...editor, exists: await commandExists(editor.cmd) })),
  );

  return results.filter((e) => e.exists).map(({ cmd, name }) => ({ cmd, name }));
}

/**
 * Check if GitHub CLI (gh) is installed.
 */
export function detectGhCli(): Promise<boolean> {
  return commandExists("gh");
}

/**
 * Check if GitHub CLI is authenticated.
 */
export async function isGhAuthenticated(): Promise<boolean> {
  try {
    await $`gh auth status`.quiet();
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the default branch name from git config or use 'main'.
 */
export async function getDefaultBranch(cwd?: string): Promise<string> {
  try {
    // Try to get from git config
    const args = cwd ? ["-C", cwd] : [];
    const branch = (await $`git ${args} config --get init.defaultBranch`.text()).trim();
    if (branch) return branch;
  } catch {
    // Ignore
  }

  // If in a repo, try to get the default branch from remote
  if (cwd) {
    try {
      const remote = (await $`git -C ${cwd} symbolic-ref refs/remotes/origin/HEAD`.text()).trim();
      const match = remote.match(/refs\/remotes\/origin\/(.+)/);
      if (match && match[1]) return match[1];
    } catch {
      // Ignore
    }
  }

  return "main";
}

/**
 * Get the current branch name.
 */
export async function getCurrentBranch(cwd: string): Promise<string> {
  try {
    const branch = (await $`git -C ${cwd} rev-parse --abbrev-ref HEAD`.text()).trim();
    return branch;
  } catch {
    return "main";
  }
}

/**
 * Check if there are uncommitted changes in the repository.
 */
export async function hasUncommittedChanges(cwd: string): Promise<boolean> {
  try {
    // Check for staged changes
    const staged = await $`git -C ${cwd} diff --cached --quiet`.quiet().then(
      () => false,
      () => true,
    );
    if (staged) return true;

    // Check for unstaged changes
    const unstaged = await $`git -C ${cwd} diff --quiet`.quiet().then(
      () => false,
      () => true,
    );
    if (unstaged) return true;

    // Check for untracked files
    const untracked = (await $`git -C ${cwd} ls-files --others --exclude-standard`.text()).trim();
    if (untracked) return true;

    return false;
  } catch {
    return false;
  }
}

/**
 * Detailed status of a worktree for removal safety checks.
 */
export interface WorktreeStatus {
  /** List of untracked file paths */
  untrackedFiles: string[];
  /** Number of staged files */
  stagedCount: number;
  /** Number of unstaged modified files */
  unstagedCount: number;
  /** Number of commits ahead of upstream, or null if no upstream */
  aheadCount: number | null;
}

/**
 * Get detailed worktree status for safety checks before removal.
 */
export async function getWorktreeStatus(cwd: string): Promise<WorktreeStatus> {
  // Get untracked files
  let untrackedFiles: string[] = [];
  try {
    const untracked = (await $`git -C ${cwd} ls-files --others --exclude-standard`.text()).trim();
    if (untracked) {
      untrackedFiles = untracked.split("\n");
    }
  } catch {
    // Ignore errors
  }

  // Get staged file count
  let stagedCount = 0;
  try {
    const staged = (await $`git -C ${cwd} diff --cached --name-only`.text()).trim();
    if (staged) {
      stagedCount = staged.split("\n").length;
    }
  } catch {
    // Ignore errors
  }

  // Get unstaged file count
  let unstagedCount = 0;
  try {
    const unstaged = (await $`git -C ${cwd} diff --name-only`.text()).trim();
    if (unstaged) {
      unstagedCount = unstaged.split("\n").length;
    }
  } catch {
    // Ignore errors
  }

  // Get commits ahead of upstream
  let aheadCount: number | null = null;
  try {
    const result = (await $`git -C ${cwd} rev-list --count @{upstream}..HEAD`.text()).trim();
    aheadCount = Number.parseInt(result, 10);
  } catch {
    // No upstream - leave as null
  }

  return { untrackedFiles, stagedCount, unstagedCount, aheadCount };
}

/**
 * Check if wt.yaml already exists at the given path.
 */
export function wtConfigExists(cwd: string): Promise<boolean> {
  const configPath = `${cwd}/wt.yaml`;
  return Bun.file(configPath).exists();
}

/**
 * Check if running in a TTY (interactive terminal).
 */
export function isTTY(): boolean {
  return process.stdin.isTTY === true;
}
