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
 * `SHELL_PROCESS_GROUP_SPAWN_OPTIONS`; otherwise it is not a group leader, the group signal
 * fails (ESRCH, since no group with that id exists), and only `proc` itself is signalled as
 * a fallback. Signalling an already-exited process is a no-op in both paths.
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
 * Terminates the process group led by `proc` with SIGTERM, escalating to SIGKILL after a
 * grace period. The escalation is unconditional: the shell (group leader) usually dies on
 * SIGTERM right away, but a descendant that ignores SIGTERM, or one with a slow graceful
 * shutdown handler, can outlive it. Neither the leader's exit nor EOF on the inherited stdio
 * pipes proves the group is gone (a descendant that redirects its stdio releases the pipes
 * the moment the shell dies), so callers must not cancel the escalation. SIGKILL to an
 * already-reaped group is a no-op, and the timer is unref'd so it never keeps the process alive.
 */
export function terminateProcessGroup(proc: Bun.Subprocess): void {
  killProcessGroup(proc, "SIGTERM");
  setTimeout(() => killProcessGroup(proc, "SIGKILL"), HARD_KILL_GRACE_MS).unref();
}
