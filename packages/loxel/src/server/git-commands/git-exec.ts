/**
 * The one place the server starts a git process for `run-git.ts`. Requests and results are plain
 * data and this module has no dependencies, so it can run on another thread.
 */

export interface GitExecRequest {
  /** Everything after `git`, including any `-C`. */
  args: readonly string[];
  /** The child's complete environment. `Bun.spawn` does not see later `process.env` changes. */
  env: Record<string, string>;
  /** Without one the child inherits the server's stdin. */
  stdin?: Uint8Array;
}

export interface GitExecResult {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
  /** Synchronous time `Bun.spawn` held the calling thread. */
  spawnBlockMs: number;
  /** From before the spawn until the child exited and its output was read. */
  wallMs: number;
}

/** The subcommand, skipping git's global options: a name for a command that carries no paths or messages. */
export function gitCommandLabel(args: readonly string[]): string {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "-c" || arg === "-C") i++;
    else if (!arg.startsWith("-")) return `git ${arg}`;
  }
  return "git";
}

/** A git that cannot be started reports exit code 1 with the reason on stderr, without rejecting. */
export async function execGit({ args, env, stdin }: GitExecRequest): Promise<GitExecResult> {
  const start = performance.now();
  let proc;
  try {
    proc = Bun.spawn(["git", ...args], {
      env,
      stdin: stdin ?? "inherit",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    const elapsed = performance.now() - start;
    return {
      exitCode: 1,
      stdout: new Uint8Array(),
      stderr: new TextEncoder().encode(`${err instanceof Error ? err.message : String(err)}\n`),
      spawnBlockMs: elapsed,
      wallMs: elapsed,
    };
  }
  const spawnBlockMs = performance.now() - start;

  const [stdout, stderr, exitCode] = await Promise.all([
    Bun.readableStreamToBytes(proc.stdout),
    Bun.readableStreamToBytes(proc.stderr),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr, spawnBlockMs, wallMs: performance.now() - start };
}
