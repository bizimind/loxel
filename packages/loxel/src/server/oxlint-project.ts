/** What a worktree says about oxlint, read from disk without running anything. */
import { existsSync, realpathSync, statSync, type Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

import { isRecord } from "@/lib/is-record";

import {
  hasInstalledPackage,
  isFile,
  namesDependency,
  notInstalledMessage,
  projectDirs,
  readPackageJson,
} from "./js-project";
import { isInside, runGit } from "./shipped-by-repo";

export const OXLINT_PACKAGE = "oxlint";

/** The names oxlint loads a config from, per directory. Checked against 1.86.0. */
const CONFIG_FILES = [".oxlintrc.json", ".oxlintrc.jsonc", "oxlint.config.ts", "oxlint.config.mts"];

/**
 * Most directories {@link scanWorktree} visits, about 15 seconds at the 150 µs each measured. A tree
 * with more than this outside `node_modules` and what git ignores gets no answer.
 */
const DEFAULT_MAX_SCANNED_DIRS = 100_000;

/** What oxlint runs for its type-aware rules, found from its workspace root upward. */
const TYPE_CHECKER = path.join("node_modules", ".bin", "tsgolint");

export function isOxlintConfigFile(file: string): boolean {
  return CONFIG_FILES.includes(path.basename(file));
}

function holdsConfig(dir: string): boolean {
  return CONFIG_FILES.some((name) => existsSync(path.join(dir, name)));
}

/** The nearest directory from `file` up to the worktree saying that its project uses oxlint. */
export function findOxlintProjectDir(file: string, wtPath: string): string | null {
  for (const dir of projectDirs(file, wtPath)) {
    if (CONFIG_FILES.some((name) => isFile(path.join(dir, name)))) return dir;
    if (namesDependency(readPackageJson(dir), OXLINT_PACKAGE)) return dir;
  }
  return null;
}

/** Whether oxlint would lint `file` the way the terminal does: its project uses it, and has it. */
export function isOxlintFile(file: string, wtPath: string): boolean {
  return (
    findOxlintProjectDir(file, wtPath) !== null && hasInstalledPackage(OXLINT_PACKAGE, file, wtPath)
  );
}

/** What to tell the user about a project that uses oxlint without having it installed. */
export function oxlintNotInstalledMessage(projectDir: string, wtPath: string): string {
  return notInstalledMessage(
    { name: "oxlint", packageName: OXLINT_PACKAGE, sign: "uses oxlint" },
    projectDir,
    wtPath,
  );
}

export interface ScanOptions {
  maxDirs?: number;
  /** Stops the walk, for an answer no one is waiting for any more. */
  signal?: AbortSignal;
}

/** What a server for this worktree would run and load. */
export interface OxlintWorktreeScan {
  /** Whether a config or a dependency outside nested repositories says the worktree uses oxlint. */
  usesOxlint: boolean;
  /** Directories outside nested repositories with oxlint in their `node_modules`, nearest first. */
  installDirs: string[];
  /** Roots of the repositories nested in the worktree that hold an oxlint config. */
  nestedConfigRepos: string[];
  /** The directories whose trust covers what oxlint would use from above the worktree. */
  ancestorRepos: string[];
  /** Whether part of the worktree went unseen: over the limit, or unreadable. */
  incomplete: boolean;
}

/**
 * The directories the server is sure to skip. It follows only `.gitignore` files, as they are
 * spelled, from the root of a repository: not `core.ignorecase`, global excludes or `info/exclude`
 * across every layout, nor those of a repository around the worktree. Git answers for those exact
 * rules, and anything else is walked.
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
 * A language server's start reads every config it can see below its root, nested repositories and
 * the targets of symbolic links included, and looks above its root for what the root does not have.
 * So those are looked for first. What `.gitignore` covers and `node_modules` are skipped, as the
 * server skips them.
 */
export async function scanWorktree(
  wtPath: string,
  { maxDirs = DEFAULT_MAX_SCANNED_DIRS, signal }: ScanOptions = {},
): Promise<OxlintWorktreeScan> {
  const ignored = await ignoredDirs(wtPath);
  let usesOxlint = false;
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
    const hasConfig = CONFIG_FILES.some((name) => names.has(name));
    if (repo) {
      if (hasConfig) nestedConfigRepos.add(repo);
    } else {
      usesOxlint ||=
        hasConfig ||
        (names.has("package.json") && namesDependency(readPackageJson(dir), OXLINT_PACKAGE));
      if (
        names.has("node_modules") &&
        isFile(path.join(dir, "node_modules", OXLINT_PACKAGE, "package.json"))
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
      } else if (entry.isSymbolicLink() && isDirectoryLink(child)) {
        const target = realpathSync(child);
        if (linkTargets.has(target)) continue;
        linkTargets.add(target);
        queue.push({ dir: child, repo: linkTargetRepo(target, wtPath) });
      }
    }
  }
  return {
    usesOxlint,
    installDirs,
    nestedConfigRepos: [...nestedConfigRepos],
    ancestorRepos: findAncestorRepos(wtPath),
    incomplete,
  };
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
function owningRepo(dir: string): string {
  for (let owner: string | null = dir; owner; owner = above(owner)) {
    if (existsSync(path.join(owner, ".git"))) return owner;
  }
  return dir;
}

/** The nearest directory above the worktree that `holds` something. */
function nearestAbove(wtPath: string, holds: (dir: string) => boolean): string | null {
  for (let dir = above(wtPath); dir; dir = above(dir)) {
    if (holds(dir)) return dir;
  }
  return null;
}

/** With none of its own in the worktree, oxlint looks upward for a config and for its type checker. */
function findAncestorRepos(wtPath: string): string[] {
  const hasOwnConfig = CONFIG_FILES.some((name) => isFile(path.join(wtPath, name)));
  const hasOwnTypeChecker = isFile(path.join(wtPath, TYPE_CHECKER));
  const found = [
    hasOwnConfig ? null : nearestAbove(wtPath, holdsConfig),
    hasOwnTypeChecker
      ? null
      : nearestAbove(wtPath, (dir) => existsSync(path.join(dir, TYPE_CHECKER))),
  ];
  return [...new Set(found.flatMap((dir) => (dir ? [owningRepo(dir)] : [])))];
}
