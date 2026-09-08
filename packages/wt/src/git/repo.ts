import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";

import { wrapError } from "@bizimind/cli-common";

import { git, runGit } from "./run.ts";

export type RepoType = "empty" | "bare" | "regular" | "worktree";

/**
 * Classify the repository at `cwd`.
 * Anything that is not a git repository is reported as "empty".
 */
export async function detectRepoType(cwd: string): Promise<RepoType> {
  const gitDir = await runGit(["rev-parse", "--git-dir"], cwd);
  if (gitDir.exitCode !== 0) return "empty";

  // A linked worktree's git dir lives under the main repo's worktrees/ dir.
  if (gitDir.stdout.includes("/worktrees/")) return "worktree";

  const isBare = await runGit(["rev-parse", "--is-bare-repository"], cwd);
  if (isBare.stdout.trim() === "true") return "bare";

  return "regular";
}

/** Whether the repository has staged, unstaged, or untracked changes. */
export async function hasUncommittedChanges(cwd: string): Promise<boolean> {
  const status = await runGit(["status", "--porcelain"], cwd);
  if (status.exitCode !== 0) return false;
  return status.stdout.trim().length > 0;
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
 * tree into `<cwd>/<worktreesDir>/<currentBranch>`.
 */
export async function transformToBare(
  cwd: string,
  currentBranch: string,
  worktreesDir: string,
): Promise<void> {
  await assertCanTransformToBare(cwd);

  const gitDir = join(cwd, ".git");
  const worktreePath = join(cwd, worktreesDir, currentBranch);
  if (await pathExists(worktreePath)) {
    throw new Error(`Cannot convert because the destination already exists: ${worktreePath}`);
  }

  try {
    await moveFilesToWorktree(cwd, worktreePath, worktreesDir);
    await convertToBareRepo(cwd, gitDir);
    await registerWorktree(cwd, worktreePath, currentBranch);
  } catch (err) {
    throw wrapError("Failed to transform to bare repository", err);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

/** Reject conversion before any files move when linked worktrees already exist. */
export async function assertCanTransformToBare(cwd: string): Promise<void> {
  const worktreeList = await git(["worktree", "list", "--porcelain"], cwd);
  const worktreeCount = worktreeList
    .split("\n")
    .filter((line) => line.startsWith("worktree ")).length;
  if (worktreeCount > 1) {
    throw new Error("Cannot convert a repository that already has linked worktrees.");
  }
}

/** Create the worktrees directory if it does not exist. */
export async function ensureWorktreesDir(cwd: string, worktreesDir: string): Promise<void> {
  await mkdir(join(cwd, worktreesDir), { recursive: true });
}

/** Move working tree files into the worktree directory. */
async function moveFilesToWorktree(
  cwd: string,
  worktreePath: string,
  worktreesDir: string,
): Promise<void> {
  await mkdir(worktreePath, { recursive: true });

  const entries = await readdir(cwd);
  const toMove = entries.filter((entry) => entry !== ".git" && entry !== worktreesDir);

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
 * written by hand and then validated with `git worktree repair`.
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
