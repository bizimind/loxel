import { mkdir, readdir, realpath, rmdir, stat } from "node:fs/promises";
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

  // Git refuses a non-force removal whenever the worktree's git dir has a
  // `modules` directory, clean or not, populated or not. Escalate to --force
  // only when nothing would be lost; --force itself skips that check, so it
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
  if (status.changes.length > 0) {
    throw new Error(`Failed to remove worktree at ${path}: it now has local changes`);
  }
  // A linked worktree keeps its submodules' object stores under its own git
  // dir, so removal destroys any commit that only exists there.
  const probe = await submodulesWithLocalOnlyCommits(path);
  if (!probe.ok) {
    throw new Error(
      `Failed to remove worktree at ${path}: cannot inspect its submodules: ${probe.reason}`,
    );
  }
  if (probe.paths.length > 0) {
    throw new Error(
      `Failed to remove worktree at ${path}: submodule ${probe.paths.join(", ")} has commits no remote has; pass --force to discard them`,
    );
  }
  const escalated = await runGit(["worktree", "remove", "--force", path], root);
  if (escalated.exitCode !== 0) {
    throw new Error(`Failed to remove worktree at ${path}: ${gitFailure(escalated)}`);
  }
}

const SUBMODULE_REFUSAL = /working trees containing submodules cannot be moved or removed/i;

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
  return status.ok ? status.changes.length > 0 : true;
}

export type WorktreeStatus = { ok: true; changes: string[] } | { ok: false; reason: string };

/**
 * Porcelain status lines (modified, staged and untracked), or the git failure
 * when the status cannot be determined. A checkout that has disappeared
 * reports no changes.
 *
 * Initialized submodules are walked explicitly and recursively; `git status`
 * alone honours `submodule.<name>.ignore` for nested levels, which would hide
 * their changes.
 */
export async function worktreeStatus(worktreePath: string): Promise<WorktreeStatus> {
  if (!(await pathExists(worktreePath))) return { ok: true, changes: [] };
  const top = await runGit(["status", ...STATUS_ARGS], worktreePath);
  if (top.exitCode !== 0) return { ok: false, reason: gitFailure(top) };
  const nested = await runGit(
    [
      "submodule",
      "foreach",
      "--recursive",
      "--quiet",
      `printf '%s\\0' "${SUBMODULE_MARKER}$displaypath"; git status ${STATUS_ARGS.join(" ")}`,
    ],
    worktreePath,
  );
  if (nested.exitCode !== 0) return { ok: false, reason: gitFailure(nested) };

  const inner = parseStatus(nested.stdout);
  // A gitlink line for a submodule whose own changes are listed would count
  // the same work twice; keep it only when nothing inside explains it.
  const changes = parseStatus(top.stdout)
    .concat(inner)
    .filter((entry) => !inner.some((change) => change.path.startsWith(`${entry.path}/`)))
    .map((entry) =>
      entry.from === undefined
        ? `${entry.code} ${entry.path}`
        : `${entry.code} ${entry.from} -> ${entry.path}`,
    );
  return { ok: true, changes };
}

// NUL-separated output keeps paths raw: the porcelain v1 text format C-quotes
// paths with spaces or non-ASCII characters, which would never match the raw
// `$displaypath` of `git submodule foreach`.
const STATUS_ARGS = ["--porcelain", "-z", "--ignore-submodules=none"];

interface StatusEntry {
  /** The two-character XY status code. */
  code: string;
  /** Path relative to the worktree root, through any enclosing submodules. */
  path: string;
  /** The original path of a rename or copy. */
  from?: string;
}

/** Parse `git status --porcelain -z` output, with submodule markers setting the path prefix. */
function parseStatus(output: string): StatusEntry[] {
  const fields = output.split("\0");
  const entries: StatusEntry[] = [];
  let prefix = "";
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i]!;
    if (field.startsWith(SUBMODULE_MARKER)) {
      prefix = `${field.slice(SUBMODULE_MARKER.length)}/`;
      continue;
    }
    if (field.length < 4) continue;
    const code = field.slice(0, 2);
    const entry: StatusEntry = { code, path: `${prefix}${field.slice(3)}` };
    // A rename or copy is followed by its original path as a separate field.
    if (code.includes("R") || code.includes("C")) {
      i += 1;
      entry.from = `${prefix}${fields[i] ?? ""}`;
    }
    entries.push(entry);
  }
  return entries;
}

/**
 * Submodules holding commits absent from every remote, named by their store
 * under the worktree's `modules` directory (nested stores as `outer/inner`).
 *
 * Probing the stores rather than `git submodule foreach` also covers a
 * submodule that was deinitialized or removed from the tree: git leaves its
 * object store behind, and that store is deleted with the worktree. A
 * checkout that has disappeared has none left to lose.
 */
export async function submodulesWithLocalOnlyCommits(
  worktreePath: string,
): Promise<{ ok: true; paths: string[] } | { ok: false; reason: string }> {
  if (!(await pathExists(worktreePath))) return { ok: true, paths: [] };
  const gitDir = await runGit(["rev-parse", "--path-format=absolute", "--git-dir"], worktreePath);
  if (gitDir.exitCode !== 0) return { ok: false, reason: gitFailure(gitDir) };

  const paths: string[] = [];
  for (const store of await submoduleStores(join(gitDir.stdout.trim(), "modules"))) {
    // An explicit work tree keeps git from honouring the store's own
    // core.worktree, which may point at a directory that no longer exists.
    const result = await runGit(
      [
        "--git-dir",
        store.gitDir,
        "--work-tree",
        worktreePath,
        "rev-list",
        "--all",
        "--not",
        "--remotes",
        "--max-count=1",
      ],
      worktreePath,
    );
    if (result.exitCode !== 0) return { ok: false, reason: gitFailure(result) };
    if (result.stdout.trim().length > 0) paths.push(store.name);
  }
  return { ok: true, paths };
}

/** Submodule object stores below a `modules` directory, nested submodules included. */
async function submoduleStores(
  modulesDir: string,
  prefix = "",
): Promise<Array<{ name: string; gitDir: string }>> {
  if (!(await pathExists(modulesDir))) return [];
  const stores: Array<{ name: string; gitDir: string }> = [];
  for (const entry of await readdir(modulesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(modulesDir, entry.name);
    const name = `${prefix}${entry.name}`;
    if (await pathExists(join(dir, "HEAD"))) {
      stores.push({ name, gitDir: dir });
      stores.push(...(await submoduleStores(join(dir, "modules"), `${name}/`)));
      continue;
    }
    // A submodule name containing slashes nests its store under those directories.
    stores.push(...(await submoduleStores(dir, `${name}/`)));
  }
  return stores;
}

const SUBMODULE_MARKER = "@@";

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
