import { gitExecClient } from "../git-exec-client";
import { recordWorkerSpawn } from "../spawn-metrics";
import { gitCommandLabel } from "./git-exec";

export interface RunGitOptions {
  /** Passed as a leading `-C`, so a missing directory is git's exit 128 rather than a spawn error. */
  cwd?: string;
  /** The child's complete environment. Defaults to a copy of `process.env`. */
  env?: Record<string, string>;
  stdin?: string | Uint8Array;
  /** Return a non-zero exit as a result instead of throwing {@link GitCommandError}. */
  nothrow?: boolean;
  /** Kill git if it runs longer than this, as for a command that needs the network. */
  timeoutMs?: number;
}

export interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** `describeError` (error-message.ts) reads the diagnostic off `stderr`. */
export class GitCommandError extends Error {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;

  constructor({ exitCode, stdout, stderr }: GitResult) {
    super(`Failed with exit code ${exitCode}`);
    this.name = "GitCommandError";
    this.exitCode = exitCode;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

/** The server's current environment, for commands with no special needs. */
export function inheritedGitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function decode(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString();
}

/**
 * Run `git <args>` on the git exec worker and collect its output. Every git command in
 * `git-commands/` goes through here. Rejects, whatever `nothrow` says, if the worker dies first.
 */
export async function runGit(
  args: readonly string[],
  { cwd, env, stdin, nothrow = false, timeoutMs }: RunGitOptions = {},
): Promise<GitResult> {
  const executed = await gitExecClient.exec({
    args: cwd === undefined ? args : ["-C", cwd, ...args],
    env: env ?? inheritedGitEnv(),
    stdin: typeof stdin === "string" ? Buffer.from(stdin) : stdin,
    timeoutMs,
  });
  recordWorkerSpawn(gitCommandLabel(args), executed.spawnBlockMs, executed.wallMs);

  const result: GitResult = {
    exitCode: executed.exitCode,
    stdout: decode(executed.stdout),
    stderr: decode(executed.stderr),
  };
  if (result.exitCode !== 0 && !nothrow) throw new GitCommandError(result);
  return result;
}

/** {@link runGit}, for the commands whose stdout is all the caller needs. */
export async function gitText(args: readonly string[], options?: RunGitOptions): Promise<string> {
  return (await runGit(args, options)).stdout;
}
