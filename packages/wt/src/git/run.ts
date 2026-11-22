import { AsyncLocalStorage } from "node:async_hooks";

import { $ } from "bun";

export interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const scopedGitEnv = new AsyncLocalStorage<Record<string, string>>();

/**
 * Run `fn` with `env` added to the environment of every git command wt runs on its behalf, however
 * deep, for an app that runs git in a repository with settings of its own (for example config that
 * keeps the repository's hooks from running). Outside such a scope git gets wt's usual environment.
 */
export function withGitEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  return scopedGitEnv.run({ ...scopedGitEnv.getStore(), ...env }, fn);
}

/**
 * Run a git command without throwing, so callers can branch on the exit code
 * while keeping git's own stderr.
 */
export async function runGit(args: string[], cwd?: string): Promise<GitResult> {
  try {
    const shell = cwd ? $`git ${args}`.cwd(cwd) : $`git ${args}`;
    const result = await shell
      .env({ ...process.env, ...scopedGitEnv.getStore(), LANG: "C", LC_ALL: "C" })
      .quiet()
      .nothrow();

    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString().trim(),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      exitCode: 128,
      stdout: "",
      stderr: cwd ? `cannot change to '${cwd}': ${message}` : message,
    };
  }
}

/**
 * Run a git command and return its trimmed stdout.
 * Throws an error carrying git's stderr — never a bare exit code.
 */
export async function git(args: string[], cwd?: string): Promise<string> {
  const result = await runGit(args, cwd);
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${gitFailure(result)}`);
  }
  return result.stdout.trim();
}

/** True when git exited 0. For probes where failure is a legitimate answer. */
export async function gitSucceeds(args: string[], cwd?: string): Promise<boolean> {
  return (await runGit(args, cwd)).exitCode === 0;
}

/** git's own explanation for a failure, falling back to the exit code. */
export function gitFailure(result: GitResult): string {
  return result.stderr || result.stdout.trim() || `exit code ${result.exitCode}`;
}
