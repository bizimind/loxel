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
 * What git says, untranslated under untrusted reads' `LANGUAGE=C` (git-env.ts), when a read needs
 * an object that isn't there: `GIT_NO_LAZY_FETCH`'s warning, `GIT_ALLOW_PROTOCOL`'s refusal on a
 * git too old for it, or the plain missing object of `git show <rev>:<path>`, which never asks to
 * download (`bad object <rev>:<path>`; a bare `bad object <sha>` is a revision that doesn't exist,
 * which trust wouldn't bring).
 */
const OBJECT_MISSING =
  /lazy fetching disabled|transport '[^']*' not allowed|bad object \S*:|unable to read tree/;

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
  if (cwd !== undefined && (await awaitsTrust(result, cwd, env))) {
    reportRepoRestriction(cwd, AWAITS_TRUST_RESTRICTION);
    throw new ContentAwaitsTrustError(result);
  }
  if (!nothrow) throw new GitCommandError(result);
  return result;
}

/**
 * Whether a failed untrusted read (one that allowed no transport) failed on an object a
 * partial clone hasn't downloaded yet. Only a partial clone counts: anywhere else a missing object
 * is not something trust would bring.
 */
async function awaitsTrust(
  result: GitResult,
  cwd: string,
  env: Record<string, string> | undefined,
): Promise<boolean> {
  if (env?.GIT_ALLOW_PROTOCOL !== "") return false;
  if (!OBJECT_MISSING.test(result.stderr) || isRepoTrusted(cwd)) return false;
  // Reading config runs nothing. A partial clone has a promisor remote (`extensions.partialClone`
  // names one; more can be marked by `remote.<name>.promisor`).
  const promisors = await runGit(
    ["config", "--get-regexp", String.raw`^(extensions\.partialclone|remote\..*\.promisor)$`],
    { cwd, env, nothrow: true },
  );
  return promisors.stdout.trim() !== "";
}

/** {@link runGit}, for the commands whose stdout is all the caller needs. */
export async function gitText(args: readonly string[], options?: RunGitOptions): Promise<string> {
  return (await runGit(args, options)).stdout;
}
