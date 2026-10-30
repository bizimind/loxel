import { recordSpawn } from "../spawn-metrics";
import { inheritedGitEnv } from "./git-env";
import { execGit } from "./git-exec";

export interface RunGitOptions {
  /** Passed as a leading `-C`, so a missing directory is git's exit 128 rather than a spawn error. */
  cwd?: string;
  /** The child's complete environment. Defaults to a copy of `process.env`. */
  env?: Record<string, string>;
  stdin?: string | Uint8Array;
  /** Return a non-zero exit as a result instead of throwing {@link GitCommandError}. */
  nothrow?: boolean;
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

/** The subcommand, skipping git's global options: what a spawn is reported under. */
function spawnLabel(args: readonly string[]): string {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "-c" || arg === "-C") i++;
    else if (!arg.startsWith("-")) return `git ${arg}`;
  }
  return "git";
}

function decode(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString();
}

/** Run `git <args>` and collect its output. Every git command in `git-commands/` goes through here. */
export async function runGit(
  args: readonly string[],
  { cwd, env, stdin, nothrow = false }: RunGitOptions = {},
): Promise<GitResult> {
  const executed = await execGit({
    args: cwd === undefined ? args : ["-C", cwd, ...args],
    env: env ?? inheritedGitEnv(),
    stdin: typeof stdin === "string" ? Buffer.from(stdin) : stdin,
  });
  recordSpawn(spawnLabel(args), executed.spawnBlockMs, executed.wallMs);

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
