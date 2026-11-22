import { AsyncLocalStorage } from "node:async_hooks";

import { $ } from "bun";

export interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

type GitEnv = Record<string, string>;

interface GitEnvScope {
  env: GitEnv;
  checkoutEnv?: (worktreePath: string) => Promise<GitEnv>;
}

const gitEnvScope = new AsyncLocalStorage<GitEnvScope>();

/**
 * Run `fn` with `env` added to the environment of every git command wt runs on its behalf, however
 * deep, for an app that runs git in a repository with settings of its own (for example config that
 * keeps the repository's hooks from running). Outside such a scope git gets wt's usual environment.
 *
 * Repository config can depend on the worktree and branch git runs in (conditional includes), so
 * an env worked out beforehand may not fit a checkout wt creates. With `checkoutEnv`, wt creates
 * such a checkout empty, asks `checkoutEnv` for the env from inside it, and fills it in under that
 * env added as well (`inNewCheckout`).
 */
export function withGitEnv<T>(
  env: GitEnv,
  fn: () => Promise<T>,
  checkoutEnv?: (worktreePath: string) => Promise<GitEnv>,
): Promise<T> {
  const outer = gitEnvScope.getStore();
  return gitEnvScope.run(
    { env: { ...outer?.env, ...env }, checkoutEnv: checkoutEnv ?? outer?.checkoutEnv },
    fn,
  );
}

/** Whether the scope fills in a new checkout in a step of its own (`withGitEnv`'s `checkoutEnv`). */
export function checksOutSeparately(): boolean {
  return gitEnvScope.getStore()?.checkoutEnv !== undefined;
}

/** Run `fn`, which fills in the checkout wt just created at `worktreePath`, under its checkout env. */
export async function inNewCheckout<T>(worktreePath: string, fn: () => Promise<T>): Promise<T> {
  const checkoutEnv = gitEnvScope.getStore()?.checkoutEnv;
  return checkoutEnv ? withGitEnv(await checkoutEnv(worktreePath), fn) : fn();
}

/**
 * Run a git command without throwing, so callers can branch on the exit code
 * while keeping git's own stderr.
 */
export async function runGit(args: string[], cwd?: string): Promise<GitResult> {
  try {
    const shell = cwd ? $`git ${args}`.cwd(cwd) : $`git ${args}`;
    const result = await shell
      .env({ ...process.env, ...gitEnvScope.getStore()?.env, LANG: "C", LC_ALL: "C" })
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
