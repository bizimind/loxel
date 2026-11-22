import { gitExecClient } from "../git-exec-client";
import { isRepoTrusted, reportRepoRestriction } from "../repo-trust";
import { recordWorkerSpawn } from "../spawn-metrics";
import { gitCommandLabel } from "./git-exec";

export interface RunGitOptions {
  /** Passed as a leading `-C`, so a missing directory is git's exit 128 rather than a spawn error. */
  cwd?: string;
  /** The child's complete environment. Defaults to a copy of `process.env`. */
  env?: Record<string, string>;
  stdin?: string | Uint8Array;
  /**
   * Return a non-zero exit as a result instead of throwing {@link GitCommandError}, except for
   * {@link ContentAwaitsTrustError}.
   */
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

/**
 * What git says when the settings of untrusted reads (git-env.ts) kept it from downloading an object
 * that a partial clone doesn't have yet: `GIT_NO_LAZY_FETCH`'s warning, or on a git too old for it,
 * `GIT_ALLOW_PROTOCOL`'s refusal.
 */
const DOWNLOAD_REFUSED = /lazy fetching disabled|transport '[^']*' not allowed/;

const AWAITS_TRUST_RESTRICTION =
  "Git doesn't download content this partial clone doesn't have yet.";

/** A read that needs content an untrusted partial clone hasn't downloaded yet. */
export class ContentAwaitsTrustError extends GitCommandError {
  constructor(result: GitResult) {
    super(result);
    this.name = "ContentAwaitsTrustError";
    this.message =
      "This content isn't downloaded yet. The repository is a partial clone, and Git downloads what it is missing once you trust the repository. Click Restricted in the status bar to choose.";
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
  if (result.exitCode === 0) return result;
  // Thrown even with `nothrow`: a caller that expects some failures still never expects this one,
  // and would show it as an empty file or diff.
  if (cwd !== undefined && DOWNLOAD_REFUSED.test(result.stderr) && !isRepoTrusted(cwd)) {
    reportRepoRestriction(cwd, AWAITS_TRUST_RESTRICTION);
    throw new ContentAwaitsTrustError(result);
  }
  if (!nothrow) throw new GitCommandError(result);
  return result;
}

/** {@link runGit}, for the commands whose stdout is all the caller needs. */
export async function gitText(args: readonly string[], options?: RunGitOptions): Promise<string> {
  return (await runGit(args, options)).stdout;
}
