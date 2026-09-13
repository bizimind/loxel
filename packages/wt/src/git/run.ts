import { $ } from "bun";

export interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run a git command without throwing, so callers can branch on the exit code
 * while keeping git's own stderr.
 */
export async function runGit(args: string[], cwd?: string): Promise<GitResult> {
  try {
    const shell = cwd ? $`git ${args}`.cwd(cwd) : $`git ${args}`;
    const result = await shell.quiet().nothrow();

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
