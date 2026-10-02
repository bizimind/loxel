import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, realpath, rename, rmdir, stat } from "node:fs/promises";
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
  const base = worktreesDirPath.endsWith("/") ? worktreesDirPath : `${worktreesDirPath}/`;
  const managed = worktrees.find((wt) => !wt.bare && wt.path === base + name);
  if (managed) return managed;

  const matches = worktrees.filter(
    (wt) => !wt.bare && getWorktreeName(wt.path, worktreesDirPath) === name,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Create a worktree, either on a new branch or checking out an existing one.
 *
 * A new branch starts at `startPoint` (default: the cwd's HEAD). `--no-track`
 * keeps a branch started from a remote-tracking ref such as `origin/main` from
 * adopting it as upstream, which would send `git pull` to main and make `git
 * push` refuse under the default push policy.
 */
export async function addWorktree(
  root: string,
  path: string,
  options: { newBranch?: string; branch?: string; startPoint?: string },
): Promise<void> {
  if (options.newBranch) {
    // `--` keeps a start point that begins with `-` from being read as an option.
    const start = options.startPoint ? ["--", options.startPoint] : [];
    await git(["worktree", "add", "--no-track", "-b", options.newBranch, path, ...start], root);
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

  // Git refuses a non-force removal whenever the worktree's git dir has a
  // `modules` directory, clean or not, populated or not. Escalate to --force
  // only when the worktree is clean; --force itself skips that check, so it
  // never refuses for this reason.
  const reason = gitFailure(result);
  if (force || !SUBMODULE_REFUSAL.test(reason)) {
    throw new Error(`Failed to remove worktree at ${path}: ${reason}`);
  }

  // An unreadable status must not count as clean.
  const status = await worktreeStatus(path);
  if (!status.ok) {
    throw new Error(
      `Failed to remove worktree at ${path}: cannot verify it is clean: ${status.reason}`,
    );
  }
  if (status.value.length > 0) {
    throw new Error(`Failed to remove worktree at ${path}: it now has local changes`);
  }
  const escalated = await runGit(["worktree", "remove", "--force", path], root);
  if (escalated.exitCode !== 0) {
    throw new Error(`Failed to remove worktree at ${path}: ${gitFailure(escalated)}`);
  }
}

const SUBMODULE_REFUSAL = /working trees containing submodules cannot be moved or removed/i;

/** Directory under the worktrees directory where detached checkouts wait to be deleted. */
export const TRASH_DIR = ".wt-trash";

/**
 * Unregister a worktree without waiting for its files to be deleted.
 *
 * Deleting the checkout is nearly all of a removal's time (seconds for a tree
 * with installed dependencies), and git keeps the worktree registered until it
 * is done. Renaming the checkout into the trash is instant; `git worktree
 * remove --force` then has only the metadata of a missing checkout to delete,
 * and a detached `rm -rf` that outlives the caller deletes the files. The
 * trash is inside the worktrees directory so the rename never crosses a
 * filesystem.
 *
 * Only this removal's own parked checkout is ever deleted: another removal's
 * checkout may still be registered while it sits in the trash, and so is one
 * left there by a crash or by a failed move back.
 *
 * `--force` skips git's clean check, so the caller must have verified the
 * worktree is clean (or that force is meant). It does not skip a lock: when
 * git refuses, the checkout is moved back and the refusal is thrown.
 *
 * @returns false when the checkout could not be moved (missing, or on another
 *   filesystem); the worktree is untouched, and the caller should use
 *   `removeWorktree`.
 */
export async function detachWorktree(
  root: string,
  path: string,
  worktreesDirPath: string,
): Promise<boolean> {
  const parked = join(worktreesDirPath, TRASH_DIR, `${basename(path)}-${randomUUID()}`);
  try {
    await mkdir(dirname(parked), { recursive: true });
    await rename(path, parked);
  } catch {
    return false;
  }

  const result = await runGit(["worktree", "remove", "--force", path], root);
  if (result.exitCode !== 0) {
    const reason = gitFailure(result);
    try {
      await rename(parked, path);
    } catch (error) {
      throw new Error(
        `Failed to remove worktree at ${path}: ${reason}. Its files could not be moved back from ${parked}`,
        { cause: error },
      );
    }
    throw new Error(`Failed to remove worktree at ${path}: ${reason}`);
  }

  deleteInBackground(parked);
  return true;
}

/**
 * Delete `path` in a detached process, so the caller can return (or exit) at
 * once. Best effort: if `rm` cannot start, the files stay in the trash.
 */
function deleteInBackground(path: string): void {
  const child = spawn("/bin/rm", ["-rf", "--", path], { detached: true, stdio: "ignore" });
  // A spawn failure arrives as an `error` event; unhandled, it would kill the caller.
  child.on("error", () => {});
  child.unref();
}

/**
 * Remove empty directories left between `from` and `stopAt` after a nested
 * worktree is removed or moved away, so its name can be reused. `git worktree`
 * never prunes the intermediate directories `feat/foo` needed.
 */
export async function pruneEmptyParents(from: string, stopAt: string): Promise<void> {
  let cursor = resolve(from);
  const stop = resolve(stopAt);
  while (cursor !== stop && cursor.startsWith(`${stop}/`)) {
    try {
      await rmdir(cursor);
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code === "ENOTEMPTY" || code === "EEXIST") return;
      if (code !== "ENOENT") throw error;
    }
    cursor = dirname(cursor);
  }
}

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
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Whether a worktree has uncommitted or untracked changes.
 *
 * An unreadable status counts as dirty so that every guard fails closed; a
 * caller's `force` is the only way past it. A checkout that has disappeared
 * has nothing left to lose and is clean.
 */
export async function isWorktreeDirty(worktreePath: string): Promise<boolean> {
  const status = await worktreeStatus(worktreePath);
  return status.ok ? status.value.length > 0 : true;
}

/** A read-only git inspection that either yields a value or explains why it could not. */
export type GitProbe<T> = { ok: true; value: T } | { ok: false; reason: string };

/** Porcelain status lines of a worktree. */
export type WorktreeStatus = GitProbe<string[]>;

/**
 * Porcelain status lines (modified, staged and untracked), or the git failure
 * when the status cannot be determined. A checkout that has disappeared
 * reports no changes.
 *
 * Exactly what one top-level `git status` reports: a submodule that differs
 * is a single gitlink line.
 *
 * Design decision: dirty means what `git status` shows, nothing more. Git's
 * submodule ignore settings therefore apply wherever they come from: the
 * user's own config (`diff.ignoreSubmodules`, `submodule.<name>.ignore`), a
 * `.gitmodules` committed by the repository, and nested submodules' own
 * settings. Content hidden that way does not make the worktree dirty, so a
 * removal without force deletes it, including through the `--force`
 * escalation in `removeWorktree`. This is intended, not an oversight.
 *
 * `--ignore-submodules=none` would make git look inside every submodule
 * despite those settings. It is deliberately not passed: in repositories with
 * many, nested submodules it costs seconds on every check, and it would make
 * wt's answer differ from the `git status` the user sees.
 */
export async function worktreeStatus(worktreePath: string): Promise<WorktreeStatus> {
  if (!(await pathExists(worktreePath))) return { ok: true, value: [] };
  // NUL-separated output keeps paths raw instead of C-quoting them.
  const result = await runGit(["status", "--porcelain", "-z"], worktreePath);
  if (result.exitCode !== 0) return { ok: false, reason: gitFailure(result) };
  return { ok: true, value: parseStatus(result.stdout) };
}

/** Format `git status --porcelain -z` records as `XY path` / `XY from -> path` lines. */
function parseStatus(output: string): string[] {
  const fields = output.split("\0");
  const lines: string[] = [];
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i]!;
    if (field.length < 4) continue;
    const code = field.slice(0, 2);
    const path = field.slice(3);
    // A rename or copy is followed by its original path as a separate field.
    if (code.includes("R") || code.includes("C")) {
      i += 1;
      lines.push(`${code} ${fields[i] ?? ""} -> ${path}`);
    } else {
      lines.push(`${code} ${path}`);
    }
  }
  return lines;
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
