const GIT_URL_PATTERNS = [
  /^https?:\/\/.+\.git$/,
  /^https?:\/\/github\.com\/.+\/.+/,
  /^https?:\/\/gitlab\.com\/.+\/.+/,
  /^https?:\/\/bitbucket\.org\/.+\/.+/,
  /^git@.+:.+\/.+/,
  /^ssh:\/\/.+\/.+/,
];

export function looksLikeGitUrl(input: string): boolean {
  return GIT_URL_PATTERNS.some((p) => p.test(input.trim()));
}

export function repoNameFromUrl(url: string): string {
  const trimmed = url
    .trim()
    .replace(/\/$/, "")
    .replace(/\.git$/, "");
  // SSH-style git@host:org/repo — extract after the colon
  if (/^[^/]+:/.test(trimmed) && !trimmed.includes("://")) {
    const afterColon = trimmed.split(":").pop() ?? "";
    return afterColon.split("/").pop() || "project";
  }
  return trimmed.split("/").pop() || "project";
}
