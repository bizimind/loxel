function pushCandidate(target: string[], value: string | undefined): void {
  if (!value) {
    return;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return;
  }
  if (!target.includes(trimmed)) {
    target.push(trimmed);
  }
}

export function resolveShellBinary(): string {
  const candidates: string[] = [];
  pushCandidate(candidates, process.env.SHELL);
  pushCandidate(candidates, "bash");
  pushCandidate(candidates, "sh");
  pushCandidate(candidates, "zsh");

  for (const candidate of candidates) {
    if (candidate.includes("/")) {
      return candidate;
    }
    const resolved = Bun.which(candidate);
    if (resolved) {
      return resolved;
    }
  }

  return "sh";
}

/**
 * Spawn options that make the shell a process-group leader so the whole group
 * (the shell plus anything it forks) can be signalled together by `killProcessGroup`.
 */
export const SHELL_PROCESS_GROUP_SPAWN_OPTIONS = { detached: true } as const;

/**
 * Signals the process group led by `proc`. The process must have been spawned with
 * `SHELL_PROCESS_GROUP_SPAWN_OPTIONS`; otherwise it is not a group leader and the group
 * signal fails, in which case only `proc` itself is signalled as a fallback.
 */
export function killProcessGroup(proc: Bun.Subprocess, signal: NodeJS.Signals = "SIGTERM"): void {
  try {
    process.kill(-proc.pid, signal);
  } catch {
    proc.kill(signal);
  }
}

const HARD_KILL_GRACE_MS = 2000;

/**
 * Terminates the process group led by `proc` with SIGTERM, escalating to SIGKILL if it is
 * still running after a grace period. Returns a cleanup that cancels the escalation.
 */
export function terminateProcessGroup(proc: Bun.Subprocess): () => void {
  killProcessGroup(proc, "SIGTERM");
  const hardKill = setTimeout(() => {
    if (proc.exitCode === null && proc.signalCode === null) {
      killProcessGroup(proc, "SIGKILL");
    }
  }, HARD_KILL_GRACE_MS);
  hardKill.unref();
  return () => clearTimeout(hardKill);
}
