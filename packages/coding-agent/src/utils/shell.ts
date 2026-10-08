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

function isNoSuchProcess(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
}

/**
 * Signals the process group led by `proc`. The process must have been spawned with
 * `SHELL_PROCESS_GROUP_SPAWN_OPTIONS`; otherwise it is not a group leader and the group
 * signal fails, in which case only `proc` itself is signalled as a fallback. A group whose
 * members have all exited (ESRCH) is silently ignored.
 */
export function killProcessGroup(proc: Bun.Subprocess, signal: NodeJS.Signals = "SIGTERM"): void {
  try {
    process.kill(-proc.pid, signal);
  } catch (error) {
    if (isNoSuchProcess(error)) {
      return;
    }
    proc.kill(signal);
  }
}

const HARD_KILL_GRACE_MS = 2000;

/**
 * Terminates the process group led by `proc` with SIGTERM, escalating to SIGKILL after a
 * grace period. The escalation is unconditional: the shell (group leader) usually dies on
 * SIGTERM right away, but a descendant that ignores SIGTERM can outlive it while holding the
 * stdio pipes open, so the leader's own exit status says nothing about whether the group is
 * done. SIGKILL to an already-reaped group is a no-op. Returns a cleanup that cancels the
 * escalation once the caller has observed the group exit.
 */
export function terminateProcessGroup(proc: Bun.Subprocess): () => void {
  killProcessGroup(proc, "SIGTERM");
  const hardKill = setTimeout(() => killProcessGroup(proc, "SIGKILL"), HARD_KILL_GRACE_MS);
  hardKill.unref();
  return () => clearTimeout(hardKill);
}
