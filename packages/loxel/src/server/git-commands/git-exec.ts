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
  /** SIGTERM the child and the helpers it started if they are still running after this long. */
  timeoutMs?: number;
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
export async function execGit({
  args,
  env,
  stdin,
  timeoutMs,
}: GitExecRequest): Promise<GitExecResult> {
  const start = performance.now();
  let proc;
  try {
    proc = Bun.spawn(["git", ...args], {
      env,
      stdin: stdin ?? "inherit",
      stdout: "pipe",
      stderr: "pipe",
      // A timed command gets its own process group (and no controlling terminal), so the timeout
      // can stop the helpers git started too: see `killGroupAfter`.
      detached: timeoutMs !== undefined,
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

  const timeout = timeoutMs === undefined ? null : killGroupAfter(proc.pid, timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    Bun.readableStreamToBytes(proc.stdout),
    Bun.readableStreamToBytes(proc.stderr),
    proc.exited,
  ]).finally(() => timeout?.cancel());
  const wallMs = performance.now() - start;
  if (!timeout?.fired) return { exitCode, stdout, stderr, spawnBlockMs, wallMs };

  // Killed git's stderr would not say why it stopped. Its exit code stays git's own: a helper that
  // outlived a git that had already succeeded may be all the timeout stopped.
  const note = new TextEncoder().encode(
    `${gitCommandLabel(args)} timed out after ${timeoutMs} ms\n`,
  );
  // A fresh array, not a pooled Buffer: the worker transfers its whole ArrayBuffer.
  const withNote = new Uint8Array(stderr.length + note.length);
  withNote.set(stderr);
  withNote.set(note, stderr.length);
  return { exitCode, stdout, stderr: withNote, spawnBlockMs, wallMs };
}

/**
 * SIGTERM the process group led by `pid` after `ms`. The whole group rather than git alone: a
 * helper git started (ssh, a credential helper, a proxy command) that outlived it would keep its
 * output pipes open, and reading them would wait for that helper however long it hangs.
 */
function killGroupAfter(pid: number, ms: number): { readonly fired: boolean; cancel(): void } {
  let fired = false;
  const timer = setTimeout(() => {
    fired = true;
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      // The group is already gone.
    }
  }, ms);
  return {
    get fired() {
      return fired;
    },
    cancel: () => clearTimeout(timer),
  };
}
