import { mkdir, readdir, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";

import { wrapError } from "@bizimind/cli-common";

import { git, gitSucceeds, runGit } from "./run.ts";
import { canonicalWorktreesDir, isWorktreeDirty, pathExists } from "./worktree.ts";

export type RepoType = "empty" | "bare" | "regular" | "worktree";

/**
 * Classify the repository at `cwd`.
 * Anything that is not a git repository is reported as "empty".
 */
export async function detectRepoType(cwd: string): Promise<RepoType> {
  const dirs = await runGit(
    ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"],
    cwd,
  );
  if (dirs.exitCode !== 0) return "empty";

  // A linked worktree has its own git dir separate from the shared common dir.
  const [gitDir, commonDir] = dirs.stdout.trim().split("\n");
  if (gitDir !== commonDir) return "worktree";

  const isBare = await runGit(["rev-parse", "--is-bare-repository"], cwd);
  if (isBare.stdout.trim() === "true") return "bare";

  return "regular";
}

/** Whether the repository has staged, unstaged, or untracked changes. */
export function hasUncommittedChanges(cwd: string): Promise<boolean> {
  return isWorktreeDirty(cwd);
}

/** Initialize a bare git repository at `cwd`. */
export async function initBareRepo(cwd: string, defaultBranch: string): Promise<void> {
  try {
    await git(["init", "--bare", `--initial-branch=${defaultBranch}`, cwd]);
  } catch (err) {
    throw wrapError("Failed to initialize bare repository", err);
  }
}

/**
 * Convert a regular repository into a bare one, moving the existing working
 * tree into `<worktreesDir>/<currentBranch>`, where the worktrees directory
 * is `$WT_DIR` or `<cwd>/.worktrees` (the same rule `wt add` uses).
 *
 * @returns The absolute path of the worktree the working tree moved to
 */
export async function transformToBare(rawCwd: string, currentBranch: string): Promise<string> {
  // One frame of reference for every derived path: the worktrees dir is canonical, so the repo
  // path must be too, or a symlinked project path makes the entry filter miss `.worktrees`.
  const cwd = await realpath(rawCwd);
  const { dir, worktreePath } = await assertCanTransformToBare(cwd, currentBranch);

  const gitDir = join(cwd, ".git");
  try {
    await moveFilesToWorktree(cwd, worktreePath, dir);
    await convertToBareRepo(cwd, gitDir);
    await registerWorktree(cwd, worktreePath, currentBranch);
  } catch (err) {
    throw wrapError("Failed to transform to bare repository", err);
  }
  return worktreePath;
}

/**
 * Reject conversion before any files move when it cannot complete safely.
 *
 * @returns The worktrees directory and the path the working tree would move to
 */
export async function assertCanTransformToBare(
  rawCwd: string,
  currentBranch: string,
): Promise<{ dir: string; worktreePath: string }> {
  const cwd = await realpath(rawCwd);
  const worktreeList = await git(["worktree", "list", "--porcelain"], cwd);
  const worktreeCount = worktreeList
    .split("\n")
    .filter((line) => line.startsWith("worktree ")).length;
  if (worktreeCount > 1) {
    throw new Error("Cannot convert a repository that already has linked worktrees.");
  }

  const dir = await canonicalWorktreesDir(cwd);
  const worktreePath = join(dir, currentBranch);
  if (await pathExists(worktreePath)) {
    throw new Error(`Cannot convert because the destination already exists: ${worktreePath}`);
  }
  return { dir, worktreePath };
}

/**
 * In a regular repo the default worktrees directory sits inside the main working tree, where
 * git would report every worktree as untracked and `git add .` would stage it as a gitlink.
 * Add it to `.git/info/exclude` (local, never committed) unless it is already ignored. A bare
 * repo or a worktrees directory outside the tree needs nothing.
 */
export async function excludeWorktreesDir(root: string, worktreesDirPath: string): Promise<void> {
  const rel = relative(root, worktreesDirPath);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return;
  if ((await git(["rev-parse", "--is-bare-repository"], root)) === "true") return;
  // Trailing slash: the directory may not exist yet, and a `dir/` pattern only matches a path
  // git knows to be a directory.
  if (await gitSucceeds(["check-ignore", "-q", `${rel}/`], root)) return;

  const commonDir = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], root);
  const excludeFile = join(commonDir, "info", "exclude");
  await mkdir(dirname(excludeFile), { recursive: true });
  const file = Bun.file(excludeFile);
  const existing = (await file.exists()) ? await file.text() : "";
  const separator = existing && !existing.endsWith("\n") ? "\n" : "";
  await Bun.write(excludeFile, `${existing}${separator}/${rel}/\n`);
}

/** Create the worktrees directory (`$WT_DIR` or `<cwd>/.worktrees`) if it does not exist. */
export async function ensureWorktreesDir(cwd: string): Promise<void> {
  await mkdir(await canonicalWorktreesDir(cwd), { recursive: true });
}

/**
 * Move working tree files into the worktree directory, leaving `.git` and any
 * top-level entry that contains the worktrees directory itself in place.
 */
async function moveFilesToWorktree(
  cwd: string,
  worktreePath: string,
  worktreesDir: string,
): Promise<void> {
  await mkdir(worktreePath, { recursive: true });

  const entries = await readdir(cwd);
  const holdsWorktrees = (entry: string) => {
    const full = join(cwd, entry);
    return worktreesDir === full || worktreesDir.startsWith(`${full}/`);
  };
  const toMove = entries.filter((entry) => entry !== ".git" && !holdsWorktrees(entry));

  await Promise.all(toMove.map((entry) => rename(join(cwd, entry), join(worktreePath, entry))));
}

/** Promote the contents of .git to the repository root and mark it bare. */
async function convertToBareRepo(cwd: string, gitDir: string): Promise<void> {
  await git(["config", "--bool", "core.bare", "true"], cwd);

  const gitEntries = await readdir(gitDir);
  await Promise.all(gitEntries.map((entry) => rename(join(gitDir, entry), join(cwd, entry))));

  await rm(gitDir, { recursive: true });
}

/**
 * Register the moved working tree with git's worktree tracking.
 *
 * `git worktree add` refuses a non-empty destination, so the admin entry is
 * written by hand, its pointers fixed up with `git worktree repair`, and an
 * index created with `git reset` — `repair` never creates one, and without
 * it every tracked file reads as staged-deleted plus untracked.
 */
async function registerWorktree(cwd: string, worktreePath: string, branch: string): Promise<void> {
  const trackingDir = await availableTrackingDir(cwd, basename(worktreePath));
  await mkdir(trackingDir, { recursive: true });

  await Promise.all([
    Bun.write(join(worktreePath, ".git"), `gitdir: ${trackingDir}\n`),
    Bun.write(join(trackingDir, "HEAD"), `ref: refs/heads/${branch}\n`),
    Bun.write(join(trackingDir, "gitdir"), `${worktreePath}\n`),
    Bun.write(join(trackingDir, "commondir"), "../..\n"),
  ]);

  await git(["worktree", "repair", worktreePath], cwd);
  // Both callers guarantee a clean tree at this point, so resetting the index to HEAD is safe.
  await git(["reset", "--quiet"], worktreePath);
}

/** Pick the same flat, collision-safe shape Git uses for worktree admin directories. */
async function availableTrackingDir(cwd: string, preferredName: string): Promise<string> {
  const safeName = preferredName.replaceAll(/[^A-Za-z0-9._-]/g, "-") || "worktree";
  for (let suffix = 0; ; suffix++) {
    const name = suffix === 0 ? safeName : `${safeName}${suffix}`;
    const candidate = join(cwd, "worktrees", name);
    if (!(await pathExists(candidate))) return candidate;
  }
}
