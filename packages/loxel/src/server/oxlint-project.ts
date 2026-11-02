/** What a worktree says about oxlint, read from disk without running anything. */
import { existsSync, type Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

import {
  hasInstalledPackage,
  isFile,
  namesDependency,
  notInstalledMessage,
  projectDirs,
  readPackageJson,
} from "./js-project";
import { runGit } from "./shipped-by-repo";

export const OXLINT_PACKAGE = "oxlint";

/** The names oxlint loads a config from, per directory. Checked against 1.86.0. */
const CONFIG_FILES = [".oxlintrc.json", ".oxlintrc.jsonc", "oxlint.config.ts", "oxlint.config.mts"];

/**
 * Most directories {@link scanWorktree} visits, about 15 seconds at the 150 µs each measured. A tree
 * with more than this outside `node_modules` and what git ignores gets no answer.
 */
const DEFAULT_MAX_SCANNED_DIRS = 100_000;

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
  return notInstalledMessage({ name: "oxlint", packageName: OXLINT_PACKAGE }, projectDir, wtPath);
}

/** What a server for this worktree would run and load. */
export interface OxlintWorktreeScan {
  /** Whether a config or a dependency outside nested repositories says the worktree uses oxlint. */
  usesOxlint: boolean;
  /** Directories outside nested repositories with oxlint in their `node_modules`, nearest first. */
  installDirs: string[];
  /** Roots of the repositories nested in the worktree that hold an oxlint config. */
  nestedConfigRepos: string[];
  /** The directory whose trust covers a config oxlint would load from above the worktree. */
  ancestorConfigRepo: string | null;
  /** Whether the walk stopped at its limit, so the rest is unknown. */
  truncated: boolean;
}

async function ignoredDirs(wtPath: string): Promise<Set<string>> {
  const { exitCode, stdout } = await runGit(wtPath, [
    "ls-files",
    "-z",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--directory",
  ]);
  if (exitCode !== 0) return new Set();
  return new Set(
    stdout
      .split("\0")
      .filter((entry) => entry.endsWith("/"))
      .map((entry) => path.join(wtPath, entry.slice(0, -1))),
  );
}

async function entriesOf(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * A language server's start reads every config it can see below its root, nested repositories
 * included, and looks above its root when the root has none. So those are looked for first. What
 * git ignores and `node_modules` are skipped, as the server skips them; symbolic links are not
 * followed, by either.
 */
export async function scanWorktree(
  wtPath: string,
  maxDirs = DEFAULT_MAX_SCANNED_DIRS,
): Promise<OxlintWorktreeScan> {
  const ignored = await ignoredDirs(wtPath);
  let usesOxlint = false;
  const installDirs: string[] = [];
  const nestedConfigRepos = new Set<string>();
  const queue: { dir: string; repo: string | null }[] = [{ dir: wtPath, repo: null }];
  let truncated = false;
  // Breadth first, so that installs come nearest first.
  for (let next = 0; next < queue.length; next++) {
    if (next >= maxDirs) {
      truncated = true;
      break;
    }
    const { dir, repo: parentRepo } = queue[next]!;
    const entries = await entriesOf(dir);
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
      if (!entry.isDirectory() || entry.name === "node_modules" || entry.name === ".git") continue;
      const child = path.join(dir, entry.name);
      if (!ignored.has(child)) queue.push({ dir: child, repo });
    }
  }
  return {
    usesOxlint,
    installDirs,
    nestedConfigRepos: [...nestedConfigRepos],
    ancestorConfigRepo: findAncestorConfigRepo(wtPath),
    truncated,
  };
}

function findAncestorConfigRepo(wtPath: string): string | null {
  if (holdsConfig(wtPath)) return null;
  const above = (dir: string) => {
    const parent = path.dirname(dir);
    return parent === dir ? null : parent;
  };
  for (let dir = above(wtPath); dir; dir = above(dir)) {
    if (!holdsConfig(dir)) continue;
    for (let owner: string | null = dir; owner; owner = above(owner)) {
      if (existsSync(path.join(owner, ".git"))) return owner;
    }
    return dir;
  }
  return null;
}
