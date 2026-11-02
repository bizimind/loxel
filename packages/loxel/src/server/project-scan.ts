/** What a linter's server would find in a worktree when it starts, read without running anything. */
import { existsSync, realpathSync, statSync, type Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

import { isRecord } from "@/lib/is-record";

import { isFile, namesDependency, readPackageJson } from "./js-project";
import { isRepoTrusted } from "./repo-trust";
import { isInside, runGit } from "./shipped-by-repo";
import type { WtLspContext } from "./stdio-lsp-manager";

/**
 * Most directories {@link scanProject} visits, about 15 seconds at the 150 µs each measured. A tree
 * with more than this gets no answer.
 */
const DEFAULT_MAX_SCANNED_DIRS = 100_000;

/** What a linter's server looks at as it walks a worktree. */
export interface ProjectScanSpec {
  configFiles: readonly string[];
  packageName: string;
  /** Whether the server is sure to skip what `.gitignore` files cover. */
  skipsIgnored: boolean;
  /** Whether the server walks into the targets of symbolic links. */
  followsLinks: boolean;
}

export interface ScanOptions {
  maxDirs?: number;
  /** Stops the walk, for an answer no one is waiting for any more. */
  signal?: AbortSignal;
}

export interface ProjectScan {
  /** Whether a config or a dependency outside nested repositories says the worktree uses the tool. */
  usesTool: boolean;
  /** Directories outside nested repositories with the tool in `node_modules`, nearest first. */
  installDirs: string[];
  /** Roots of the repositories nested in the worktree that hold a config. */
  nestedConfigRepos: string[];
  /** Whether part of the worktree went unseen: over the limit, or unreadable. */
  incomplete: boolean;
}

/**
 * The directories a server following only `.gitignore` files is sure to skip: as they are spelled,
 * from the root of a repository, not `core.ignorecase`, global excludes or `info/exclude` across
 * every layout, nor those of a repository around the worktree. Git answers for those exact rules,
 * and anything else is walked.
 */
async function ignoredDirs(wtPath: string): Promise<Set<string>> {
  if (!existsSync(path.join(wtPath, ".git"))) return new Set();
  const { exitCode, stdout } = await runGit(wtPath, [
    "-c",
    "core.ignorecase=false",
    "ls-files",
    "-z",
    "--others",
    "--ignored",
    "--exclude-per-directory=.gitignore",
    "--directory",
  ]);
  if (exitCode !== 0) return new Set();
  return new Set(
    // A directory ends in a slash and a link to one does not; `path.resolve` drops the slash.
    stdout
      .split("\0")
      .filter(Boolean)
      .map((entry) => path.resolve(wtPath, entry)),
  );
}

/** A directory's entries; null when it exists and could not be read. */
async function entriesOf(dir: string): Promise<Dirent[] | null> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (err) {
    const code = isRecord(err) ? err.code : undefined;
    return code === "ENOENT" || code === "ENOTDIR" ? [] : null;
  }
}

function isDirectoryLink(file: string): boolean {
  try {
    return statSync(file).isDirectory();
  } catch {
    return false;
  }
}

/**
 * A language server's start can read every config it can see below its root, nested repositories
 * included, so those are looked for first. `node_modules` is skipped, as the servers skip it.
 */
export async function scanProject(
  wtPath: string,
  { configFiles, packageName, skipsIgnored, followsLinks }: ProjectScanSpec,
  { maxDirs = DEFAULT_MAX_SCANNED_DIRS, signal }: ScanOptions = {},
): Promise<ProjectScan> {
  const ignored = skipsIgnored ? await ignoredDirs(wtPath) : new Set<string>();
  let usesTool = false;
  let incomplete = false;
  const installDirs: string[] = [];
  const nestedConfigRepos = new Set<string>();
  const queue: { dir: string; repo: string | null }[] = [{ dir: wtPath, repo: null }];
  // Link targets already walked, so that a link to a parent ends.
  const linkTargets = new Set<string>();
  // Breadth first, so that installs come nearest first.
  for (let next = 0; next < queue.length; next++) {
    if (signal?.aborted) break;
    if (next >= maxDirs) {
      incomplete = true;
      break;
    }
    const { dir, repo: parentRepo } = queue[next]!;
    const entries = await entriesOf(dir);
    if (!entries) {
      incomplete = true;
      continue;
    }
    const names = new Set(entries.map((entry) => entry.name));
    const repo = dir !== wtPath && names.has(".git") ? dir : parentRepo;
    const hasConfig = configFiles.some((name) => names.has(name));
    if (repo) {
      if (hasConfig) nestedConfigRepos.add(repo);
    } else {
      usesTool ||=
        hasConfig ||
        (names.has("package.json") && namesDependency(readPackageJson(dir), packageName));
      if (
        names.has("node_modules") &&
        isFile(path.join(dir, "node_modules", packageName, "package.json"))
      ) {
        installDirs.push(dir);
      }
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const child = path.join(dir, entry.name);
      if (ignored.has(child)) continue;
      if (entry.isDirectory()) {
        queue.push({ dir: child, repo });
      } else if (followsLinks && entry.isSymbolicLink() && isDirectoryLink(child)) {
        const target = realpathSync(child);
        if (linkTargets.has(target)) continue;
        linkTargets.add(target);
        queue.push({ dir: child, repo: linkTargetRepo(target, wtPath) });
      }
    }
  }
  return { usesTool, installDirs, nestedConfigRepos: [...nestedConfigRepos], incomplete };
}

/** The repository whose trust covers a link's target: none of its own inside the worktree. */
function linkTargetRepo(target: string, wtPath: string): string | null {
  const root = realpathSync(wtPath);
  if (!isInside(target, root)) return owningRepo(target);
  for (let dir: string | null = target; dir && dir !== root; dir = above(dir)) {
    if (existsSync(path.join(dir, ".git"))) return dir;
  }
  return null;
}

function above(dir: string): string | null {
  const parent = path.dirname(dir);
  return parent === dir ? null : parent;
}

/** The repository around `dir`, or `dir` itself when it is in none. */
export function owningRepo(dir: string): string {
  for (let owner: string | null = dir; owner; owner = above(owner)) {
    if (existsSync(path.join(owner, ".git"))) return owner;
  }
  return dir;
}

/** The nearest directory above the worktree that `holds` something. */
export function nearestAbove(wtPath: string, holds: (dir: string) => boolean): string | null {
  for (let dir = above(wtPath); dir; dir = above(dir)) {
    if (holds(dir)) return dir;
  }
  return null;
}

/**
 * The answers about other repositories' trust that a launch decision relied on, per connection. A
 * connection with none recorded is still deciding, and so counts as stale.
 */
export class ReliedTrust {
  private readonly relied = new WeakMap<WtLspContext, Map<string, boolean>>();

  record(context: WtLspContext, dirs: readonly string[]): void {
    this.relied.set(context, new Map(dirs.map((dir) => [dir, isRepoTrusted(dir)])));
  }

  isStale(context: WtLspContext): boolean {
    if (!context.repoTrusted) return false;
    const relied = this.relied.get(context);
    if (!relied) return true;
    return [...relied].some(([dir, trusted]) => isRepoTrusted(dir) !== trusted);
  }
}
