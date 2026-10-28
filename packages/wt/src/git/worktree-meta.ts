/**
 * Worktree metadata: key/value pairs stored in each worktree's own config file
 * (the one `git config --worktree` writes to), under the `wt-meta` section.
 *
 * The file belongs to the worktree's admin entry in the git dir, not to its
 * branch or checkout, so the metadata survives a detached HEAD, a rebase, a
 * branch rename and `git worktree move`, and is deleted with the worktree.
 * Git reads it only while per-worktree config (`extensions.worktreeConfig`)
 * is on; callers check that first (see `isWorktreeConfigEnabled`).
 *
 * Files are addressed with `git config --file` rather than `--worktree`:
 * with the extension off, `--worktree` silently writes to the shared config,
 * and `--file` also reaches a worktree whose checkout is gone.
 *
 * `git worktree add` copies the config file of the worktree it runs in into
 * the new one, metadata included. So that a copy never passes for the new
 * worktree's own (a duplicate `wt-id`, a parent link it was never given), wt
 * records in each section the admin entry it was written for (`wt-owner`, a
 * path relative to the common dir, which survives moves). A section whose
 * owner is another entry is a copy: reads ignore it and the first write
 * replaces it.
 */
import { open, readdir, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import { gitFailure, runGit, type GitResult } from "./run.ts";
import { canonicalizePotentialPath, pathExists, type Worktree } from "./worktree.ts";

/** The config section holding the metadata: `wt-meta.<key>`. */
export const META_SECTION = "wt-meta";

/** The key holding a worktree's stable id, a UUID wt assigns. */
export const WORKTREE_ID_KEY = "wt-id";

/** The admin entry the section was written for. Internal: reads never report it. */
const OWNER_KEY = "wt-owner";

/** Keys starting with this are wt's own; callers cannot set or unset them. */
export const RESERVED_META_PREFIX = "wt-";

/** Metadata of one worktree: lowercase keys (without the section) to values. */
export type WorktreeMeta = Record<string, string>;

// Git config variable names: letters, digits and `-`, starting with a letter.
const KEY_PATTERN = /^[a-z][a-z0-9-]*$/i;

/** Why `key` is not a valid metadata key, or null when it is. */
export function metaKeyError(key: string): string | null {
  if (KEY_PATTERN.test(key)) return null;
  return `Invalid metadata key '${key}': use letters, digits and '-', starting with a letter.`;
}

/** Validate a key and return it in the lowercase form git stores. Throws when invalid. */
export function normalizeMetaKey(key: string): string {
  const error = metaKeyError(key);
  if (error) throw new Error(error);
  return key.toLowerCase();
}

/** Whether `key` (already normalized) is reserved for wt. */
export function isReservedMetaKey(key: string): boolean {
  return key.startsWith(RESERVED_META_PREFIX);
}

/**
 * Each worktree's own config file, keyed by the path `git worktree list`
 * reports for it. The first entry (the main worktree, or the bare repo) uses
 * `<commonDir>/config.worktree`; a linked one uses its admin dir's file, found
 * through the admin dir's `gitdir` pointer so that worktrees whose checkout is
 * gone are covered too.
 */
export async function worktreeConfigFiles(
  commonDir: string,
  worktrees: Worktree[],
): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const [first, ...linked] = worktrees;
  if (first) files.set(first.path, join(commonDir, "config.worktree"));

  // `gitdir` holds `<checkout>/.git`, absolute or (with worktree.useRelativePaths) relative to
  // the admin dir; canonicalize both sides so symlinked paths still match.
  const byPath = new Map(
    await Promise.all(
      linked.map(async (wt) => [await canonicalizePotentialPath(wt.path), wt.path] as const),
    ),
  );
  const adminRoot = join(commonDir, "worktrees");
  const ids = (await pathExists(adminRoot)) ? await readdir(adminRoot) : [];
  await Promise.all(
    ids.map(async (id) => {
      const adminDir = join(adminRoot, id);
      const pointer = Bun.file(join(adminDir, "gitdir"));
      if (!(await pointer.exists())) return;
      const checkout = dirname(resolve(adminDir, (await pointer.text()).trim()));
      const listed = byPath.get(await canonicalizePotentialPath(checkout));
      if (listed) files.set(listed, join(adminDir, "config.worktree"));
    }),
  );
  return files;
}

/**
 * The metadata in one worktree config file: empty when the file does not
 * exist, or when its section is a copy from another worktree.
 */
export async function readMeta(commonDir: string, file: string): Promise<WorktreeMeta> {
  const { [OWNER_KEY]: owner, ...meta } = await readSection(commonDir, file);
  return owner === undefined || owner === ownerOf(commonDir, file) ? meta : {};
}

/**
 * Make the section in `file` its own before a write: a copy from another
 * worktree is dropped, and the owner is recorded when missing.
 */
export async function claimMeta(commonDir: string, file: string): Promise<void> {
  const owner = (await readSection(commonDir, file))[OWNER_KEY];
  if (owner === ownerOf(commonDir, file)) return;
  if (owner === undefined) {
    await writeMeta(commonDir, file, { [OWNER_KEY]: ownerOf(commonDir, file) });
    return;
  }
  await resetMeta(commonDir, file);
}

/** Replace the section in `file` with an empty one owned by it, for a worktree wt just created. */
export async function resetMeta(commonDir: string, file: string): Promise<void> {
  await configWrite(["--remove-section", META_SECTION], file, commonDir, NO_SUCH_SECTION);
  await writeMeta(commonDir, file, { [OWNER_KEY]: ownerOf(commonDir, file) });
}

/** Set normalized keys in one worktree config file, replacing any previous values. */
export async function writeMeta(commonDir: string, file: string, values: WorktreeMeta) {
  // One git call per key: a failure partway leaves the earlier keys written. Git has no
  // multi-key write, and every key on its own is still written atomically.
  for (const [key, value] of Object.entries(values)) {
    await configWrite(["--replace-all", `${META_SECTION}.${key}`, value], file, commonDir);
  }
}

/** Remove normalized keys from one worktree config file; missing keys are fine. */
export async function unsetMeta(commonDir: string, file: string, keys: string[]) {
  for (const key of keys) {
    // Exit 5: the key was not set.
    await configWrite(
      ["--unset-all", `${META_SECTION}.${key}`],
      file,
      commonDir,
      (result) => result.exitCode === 5,
    );
  }
}

/**
 * Run `action` holding wt's lock on one worktree's metadata, so concurrent
 * read-then-write sequences (claiming a copied section, assigning a `wt-id`)
 * cannot interleave and undo each other. Git's own `<file>.lock` cannot serve:
 * it is held only for one `git config` call, and taking it here would block
 * the calls `action` makes.
 */
export async function withMetaLock<T>(file: string, action: () => Promise<T>): Promise<T> {
  const lock = `${file}.wt-lock`;
  const deadline = Date.now() + LOCK_DEADLINE_MS;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await (await open(lock, "wx")).close();
      break;
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        throw new Error(
          `Worktree metadata at ${file} is locked (if no wt process is running, delete ${lock})`,
          { cause: error },
        );
      }
      await backoff(attempt);
    }
  }
  try {
    return await action();
  } finally {
    await rm(lock, { force: true });
  }
}

/** Every `wt-meta.*` value in `file`, the first one of each key. */
async function readSection(commonDir: string, file: string): Promise<WorktreeMeta> {
  const result = await runGit(
    ["config", "--file", file, "--null", "--get-regexp", `^${META_SECTION}\\.`],
    commonDir,
  );
  // Exit 1: no matching key, or no such file.
  if (result.exitCode === 1) return {};
  if (result.exitCode !== 0) {
    throw new Error(`Cannot read worktree metadata from ${file}: ${gitFailure(result)}`);
  }

  const meta: WorktreeMeta = {};
  // NUL-terminated `<section>.<key>\n<value>` records; values may contain newlines.
  for (const record of result.stdout.split("\0")) {
    if (!record) continue;
    const newline = record.indexOf("\n");
    const name = newline === -1 ? record : record.slice(0, newline);
    // A key written without `= value` is a boolean true to git.
    const value = newline === -1 ? "true" : record.slice(newline + 1);
    // A key set more than once (by hand) reads as its first value.
    const key = name.slice(META_SECTION.length + 1);
    if (!(key in meta)) meta[key] = value;
  }
  return meta;
}

/** The owner recorded for `file`: its admin dir relative to the common dir, `.` for the main one. */
function ownerOf(commonDir: string, file: string): string {
  return relative(commonDir, dirname(file)) || ".";
}

const NO_SUCH_SECTION = (result: GitResult) => /no such section/i.test(result.stderr);

const LOCK_CONFLICT = /could not lock config file/i;
/**
 * How long to keep retrying a locked file. Writers hold a lock for
 * milliseconds, so this only runs out on a lock left behind by a crash.
 */
const LOCK_DEADLINE_MS = 30_000;

/** Wait before retry `attempt` of a locked file, a little longer each time. */
function backoff(attempt: number): Promise<void> {
  return Bun.sleep(Math.min(10 * attempt, 200) + Math.random() * 10);
}

/**
 * Run `git config --file <file> ...args`, retrying while another writer holds
 * the file's lock: git fails at once instead of waiting, so a write racing
 * another git process (a hand-run `git config --worktree`, say) would
 * otherwise fail.
 *
 * @param tolerated - Failures that count as success (e.g. unsetting a missing key)
 */
async function configWrite(
  args: string[],
  file: string,
  cwd: string,
  tolerated: (result: GitResult) => boolean = () => false,
): Promise<void> {
  const full = ["config", "--file", file, ...args];
  const deadline = Date.now() + LOCK_DEADLINE_MS;
  for (let attempt = 1; ; attempt += 1) {
    const result = await runGit(full, cwd);
    if (result.exitCode === 0 || tolerated(result)) return;

    const locked = LOCK_CONFLICT.test(result.stderr);
    if (!locked || Date.now() >= deadline) {
      const hint = locked ? ` (if no git process is running, delete ${file}.lock)` : "";
      throw new Error(`git ${full.join(" ")}: ${gitFailure(result)}${hint}`);
    }
    await backoff(attempt);
  }
}
