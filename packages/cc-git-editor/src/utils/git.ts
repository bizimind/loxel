/**
 * Git utilities
 *
 * Find real git binary and execute commands.
 */

import { statSync } from "fs";

import { $ } from "bun";

let cachedRealGit: string | null = null;

/**
 * Find the real git binary by using `which` with a filtered PATH
 * that excludes any directory containing our wrapper (by inode).
 */
export function findRealGit(): string {
  if (cachedRealGit) return cachedRealGit;

  // Get our inode to identify ourselves (handles symlinks)
  const selfInode = statSync(process.execPath).ino;

  // Filter PATH: remove any directory containing a git with our inode
  const filteredPath = (process.env.PATH || "")
    .split(":")
    .filter((dir) => {
      try {
        const gitInode = statSync(`${dir}/git`).ino;
        return gitInode !== selfInode;
      } catch {
        // No git in this dir, keep it
        return true;
      }
    })
    .join(":");

  // Use `which` with filtered PATH to find real git
  const result = Bun.spawnSync(["which", "git"], { env: { ...process.env, PATH: filteredPath } });

  if (result.exitCode !== 0) {
    throw new Error("Could not find real git binary");
  }

  cachedRealGit = result.stdout.toString().trim();
  return cachedRealGit;
}

/**
 * Execute real git with given arguments, replacing current process.
 */
export function execRealGit(args: string[]): never {
  const realGit = findRealGit();
  const result = Bun.spawnSync([realGit, ...args], { stdio: ["inherit", "inherit", "inherit"] });
  process.exit(result.exitCode ?? 0);
}

/**
 * Run a git command and return the result.
 */
export async function runGit(args: string[]): Promise<{ stdout: string; exitCode: number }> {
  const realGit = findRealGit();
  const result = await $`${realGit} ${args}`.quiet().nothrow();
  return { stdout: result.stdout.toString(), exitCode: result.exitCode };
}

/**
 * Get the git directory (.git) for the current repository.
 */
export async function getGitDir(): Promise<string> {
  const result = await runGit(["rev-parse", "--git-dir"]);
  if (result.exitCode !== 0) {
    return ".git";
  }
  return result.stdout.trim();
}
