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
