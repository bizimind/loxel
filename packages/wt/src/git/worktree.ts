import { mkdir, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { git, gitFailure, runGit } from "./run.ts";

/** Branch label used for a detached HEAD in human output and hook env. */
export const DETACHED = "(detached)";

export interface Worktree {
  /** Absolute path to the worktree */
  path: string;
  /** HEAD commit hash */
  head: string;
  /** Branch name (without refs/heads/), or null when detached */
  branch: string | null;
  /** Whether this entry is the bare repository itself */
  bare: boolean;
  /** Whether the worktree is locked */
  locked: boolean;
}

/**
 * Parse `git worktree list --porcelain` output.
 *
 * Records are separated by blank lines:
 *   worktree /path/to/worktree
 *   HEAD abc123...
 *   branch refs/heads/main
 */
export function parseWorktreeList(output: string): Worktree[] {
  const worktrees: Worktree[] = [];
  let current: Worktree | null = null;

  const flush = () => {
    if (current) worktrees.push(current);
    current = null;
  };

  for (const line of output.split("\n")) {
    if (!line.trim()) {
      flush();
      continue;
    }
    if (line.startsWith("worktree ")) {
      flush();
      current = {
        path: line.slice("worktree ".length),
        head: "",
        branch: null,
        bare: false,
        locked: false,
      };
      continue;
    }
    if (!current) continue;

    if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (line === "bare") {
      current.bare = true;
    } else if (line === "locked" || line.startsWith("locked ")) {
      current.locked = true;
    } else if (line === "detached") {
      current.branch = null;
    }
  }
  flush();

  return worktrees;
}

/** All worktrees git knows about, including the bare entry when there is one. */
export async function listWorktrees(cwd: string): Promise<Worktree[]> {
  return parseWorktreeList(await git(["worktree", "list", "--porcelain"], cwd));
}

/**
 * The repository root: the main worktree's top level, or the git dir for a
 * bare repo. Works from anywhere inside the repo, including linked worktrees.
 */
export async function resolveRepoRoot(cwd: string): Promise<string> {
  const commonDir = await runGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
  if (commonDir.exitCode !== 0) {
    throw new Error(`Not inside a git repository: ${cwd} (${gitFailure(commonDir)})`);
  }

  // git lists the main worktree first, followed by linked ones; a bare repo
  // lists its bare entry first instead. So the first entry is the root unless
  // it is bare, in which case the git dir itself is the root.
  const worktrees = await listWorktrees(cwd);
  const first = worktrees[0];
  const root = first && !first.bare ? first.path : commonDir.stdout.trim();

  return canonicalize(root);
}

/** Where new worktrees live: `$WT_DIR`, or `<root>/.worktrees` by default. */
export function worktreesDir(root: string): string {
  const override = process.env.WT_DIR;
  if (!override) return join(root, ".worktrees");
  return isAbsolute(override) ? override : resolve(root, override);
}

/** Resolve symlinks in the configured worktrees path, even before its leaf exists. */
export async function canonicalWorktreesDir(root: string): Promise<string> {
  return canonicalizePotentialPath(worktreesDir(root));
}

/**
 * A worktree's name: its path relative to the worktrees directory, so nested
 * names like `feat/foo` round-trip. Falls back to the last path segment for
 * display-only callers handling paths outside the managed directory.
 */
export function getWorktreeName(wtPath: string, worktreesDir: string): string {
  const base = worktreesDir.endsWith("/") ? worktreesDir : `${worktreesDir}/`;
  if (wtPath.startsWith(base)) return wtPath.slice(base.length);
  return basename(wtPath);
}

/**
 * Worktrees managed by wt: non-bare and under the worktrees directory.
 * Excludes nested worktrees created by other tools (e.g. Claude Code's
 * `.claude/worktrees/`), which would otherwise show up as managed entries.
 */
export function getManagedWorktrees(worktrees: Worktree[], worktreesDir: string): Worktree[] {
  const base = worktreesDir.endsWith("/") ? worktreesDir : `${worktreesDir}/`;
  return worktrees.filter((wt) => {
    if (wt.bare || !wt.path.startsWith(base)) return false;
    return !wt.path.slice(base.length).includes("/.claude/");
  });
}

/** Find one worktree by its displayed name, rejecting ambiguous basenames. */
export function findWorktree(
  worktrees: Worktree[],
  worktreesDirPath: string,
  name: string,
): Worktree | undefined {
  const matches = worktrees.filter(
    (wt) => !wt.bare && getWorktreeName(wt.path, worktreesDirPath) === name,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

/** Create a worktree, either on a new branch or checking out an existing one. */
export async function addWorktree(
  root: string,
  path: string,
  options: { newBranch?: string; branch?: string },
): Promise<void> {
  if (options.newBranch) {
    await git(["worktree", "add", "-b", options.newBranch, path], root);
    return;
  }
  if (options.branch) {
    await git(["worktree", "add", path, options.branch], root);
    return;
  }
  await git(["worktree", "add", "--detach", path], root);
}

/**
 * Move a worktree's directory and update git's admin entry.
 *
 * `git worktree move` refuses on a locked worktree unless passed `-f -f`, and
 * always refuses worktrees containing submodules. Let Git enforce those
 * invariants: a manual directory rename leaves submodule `core.worktree`
 * pointers aimed at the old path and corrupts the moved checkout.
 */
export async function moveWorktree(
  root: string,
  src: string,
  dst: string,
  force: boolean,
): Promise<void> {
  // `git worktree move` has `mv` semantics: an existing destination directory
  // means it moves *into* it, silently nesting the worktree.
  if (await pathExists(dst)) {
    throw new Error(`Path already exists: ${dst}`);
  }
  await mkdir(dirname(dst), { recursive: true });

  const args = force ? ["worktree", "move", "-f", "-f", src, dst] : ["worktree", "move", src, dst];
  const result = await runGit(args, root);
  if (result.exitCode === 0) return;

  const reason = gitFailure(result);
  const hint = force ? "" : " (retry with --force only if the worktree is locked)";
  throw new Error(`Failed to move worktree to ${dst}: ${reason}${hint}`);
}

/**
 * Remove a worktree.
 *
 * Let git enforce all worktree safety checks, including locks. A caller's
 * `force` permission covers dirty files; it must not silently bypass a lock or
 * turn an unrelated git failure into a recursive directory deletion.
 */
export async function removeWorktree(root: string, path: string, force: boolean): Promise<void> {
  const args = force ? ["worktree", "remove", "--force", path] : ["worktree", "remove", path];
  const result = await runGit(args, root);
  if (result.exitCode === 0) return;

  const reason = gitFailure(result);
  if (!SUBMODULE_REFUSAL.test(reason)) {
    throw new Error(`Failed to remove worktree at ${path}: ${reason}`);
  }

  if (!force && (await isWorktreeDirty(path))) {
    throw new Error(`Failed to remove worktree at ${path}: it now has local changes`);
  }

  if (!force) {
    const escalated = await runGit(["worktree", "remove", "--force", path], root);
    if (escalated.exitCode === 0) return;
    const escalatedReason = gitFailure(escalated);
    if (!SUBMODULE_REFUSAL.test(escalatedReason)) {
      throw new Error(`Failed to remove worktree at ${path}: ${escalatedReason}`);
    }
  }

  // Older Git versions may retain the blanket submodule refusal even with
  // --force. Only that same refusal reaches the manual compatibility path.
  await removeSubmoduleWorktreeManually(root, path);
}

/** Complete the older-Git compatibility path and report partial success. */
export async function removeSubmoduleWorktreeManually(root: string, path: string): Promise<void> {
  const [gitDirResult, commonDirResult] = await Promise.all([
    runGit(["rev-parse", "--path-format=absolute", "--git-dir"], path),
    runGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], root),
  ]);
  if (gitDirResult.exitCode !== 0 || commonDirResult.exitCode !== 0) {
    const reason =
      gitDirResult.exitCode !== 0 ? gitFailure(gitDirResult) : gitFailure(commonDirResult);
    throw new Error(`Failed to locate Git metadata for ${path}: ${reason}`);
  }

  const gitDir = await canonicalize(gitDirResult.stdout.trim());
  const worktreeMetadataRoot = join(await canonicalize(commonDirResult.stdout.trim()), "worktrees");
  if (dirname(gitDir) !== worktreeMetadataRoot) {
    throw new Error(`Refusing to remove unexpected Git metadata path: ${gitDir}`);
  }

  await rm(path, { recursive: true, force: true });
  try {
    await rm(gitDir, { recursive: true });
  } catch (err) {
    throw new Error(`Removed ${path}, but failed to remove its Git metadata`, { cause: err });
  }
}

const SUBMODULE_REFUSAL = /working trees containing submodules cannot be moved or removed/i;

/**
 * The worktree containing `dirPath`, or undefined when it is outside them all.
 *
 * Matches the longest path prefix: the default worktrees directory sits
 * *inside* the main worktree, which would otherwise always win.
 */
export function worktreeContaining(worktrees: Worktree[], dirPath: string): Worktree | undefined {
  let best: Worktree | undefined;
  for (const wt of worktrees) {
    if (wt.bare) continue;
    if (dirPath !== wt.path && !dirPath.startsWith(`${wt.path}/`)) continue;
    if (!best || wt.path.length > best.path.length) best = wt;
  }
  return best;
}

/** Whether a filesystem path exists, of any type. */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Whether a worktree has uncommitted or untracked changes. */
export async function isWorktreeDirty(worktreePath: string): Promise<boolean> {
  return (await worktreeChanges(worktreePath)).length > 0;
}

/** Porcelain status lines for a worktree (modified, staged and untracked). */
export async function worktreeChanges(worktreePath: string): Promise<string[]> {
  const output = await git(["status", "--porcelain", "--ignore-submodules=none"], worktreePath);
  return output.split("\n").filter((line) => line.trim().length > 0);
}

/** Commits ahead of / behind the upstream branch, or null when there is none. */
export async function upstreamDivergence(
  worktreePath: string,
): Promise<{ ahead: number; behind: number } | null> {
  const result = await runGit(
    ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
    worktreePath,
  );
  if (result.exitCode !== 0) return null;

  const [ahead, behind] = result.stdout.trim().split(/\s+/).map(Number);
  if (ahead === undefined || behind === undefined || Number.isNaN(ahead) || Number.isNaN(behind)) {
    return null;
  }
  return { ahead, behind };
}

/** Resolve symlinks so paths from git and from us compare equal. */
async function canonicalize(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

/** Canonicalize the longest existing ancestor and retain any missing suffix. */
async function canonicalizePotentialPath(path: string): Promise<string> {
  const suffix: string[] = [];
  let cursor = resolve(path);

  while (true) {
    try {
      return join(await realpath(cursor), ...suffix.reverse());
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      const parent = dirname(cursor);
      if (parent === cursor) return resolve(path);
      suffix.push(basename(cursor));
      cursor = parent;
    }
  }
}
