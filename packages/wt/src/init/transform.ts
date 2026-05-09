import { wrapError } from "@bizimind/cli-common";
import { $ } from "bun";
import { readdir, rename, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Initialize a bare git repository.
 */
export async function initBareRepo(cwd: string, defaultBranch: string): Promise<void> {
  try {
    await $`git init --bare --initial-branch=${defaultBranch} ${cwd}`.quiet();
  } catch (err) {
    throw wrapError("Failed to initialize bare repository", err);
  }
}

/**
 * Transform a regular git repository into a bare repository.
 */
export async function transformToBare(
  cwd: string,
  currentBranch: string,
  worktreesDir: string,
): Promise<void> {
  const gitDir = join(cwd, ".git");
  const worktreesPath = join(cwd, worktreesDir);
  const worktreePath = join(worktreesPath, currentBranch);

  try {
    await moveFilesToWorktree(cwd, worktreesPath, worktreePath, worktreesDir);
    await convertToBareRepo(cwd, gitDir);
    await registerWorktree(cwd, worktreePath, currentBranch);
  } catch (err) {
    throw wrapError("Failed to transform to bare repository", err);
  }
}

/**
 * Move working tree files into the worktree directory.
 */
async function moveFilesToWorktree(
  cwd: string,
  worktreesPath: string,
  worktreePath: string,
  worktreesDir: string,
): Promise<void> {
  await mkdir(worktreesPath, { recursive: true });
  await mkdir(worktreePath, { recursive: true });

  const entries = await readdir(cwd);
  const toMove = entries.filter((e) => e !== ".git" && e !== worktreesDir);

  await Promise.all(toMove.map((entry) => rename(join(cwd, entry), join(worktreePath, entry))));
}

/**
 * Convert .git directory to bare repo at root.
 */
async function convertToBareRepo(cwd: string, gitDir: string): Promise<void> {
  await $`git -C ${cwd} config --bool core.bare true`.quiet();

  const gitEntries = await readdir(gitDir);
  await Promise.all(gitEntries.map((entry) => rename(join(gitDir, entry), join(cwd, entry))));

  await rm(gitDir, { recursive: true });
}

/**
 * Register the worktree with git's worktree tracking system.
 */
async function registerWorktree(cwd: string, worktreePath: string, branch: string): Promise<void> {
  const bareWorktreesDir = join(cwd, "worktrees");
  await mkdir(bareWorktreesDir, { recursive: true });

  const trackingDir = join(bareWorktreesDir, branch);
  await mkdir(trackingDir, { recursive: true });

  await Promise.all([
    Bun.write(join(worktreePath, ".git"), `gitdir: ${trackingDir}\n`),
    Bun.write(join(trackingDir, "HEAD"), `ref: refs/heads/${branch}\n`),
    Bun.write(join(trackingDir, "gitdir"), `${worktreePath}\n`),
    Bun.write(join(trackingDir, "commondir"), `../..\n`),
  ]);
}

/**
 * Create the worktrees directory if it doesn't exist.
 */
export async function ensureWorktreesDir(cwd: string, worktreesDir: string): Promise<void> {
  await mkdir(join(cwd, worktreesDir), { recursive: true });
}
