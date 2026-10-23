/**
 * Shorten a path under the user's home directory to its `~` form (`/Users/me/git/app` →
 * `~/git/app`) for display. Paths outside home, or an unknown home, pass through unchanged.
 */
export function abbreviateHomePath(path: string, homeDir: string | null): string {
  if (!homeDir || homeDir === "/") return path;
  const home = homeDir.endsWith("/") ? homeDir.slice(0, -1) : homeDir;
  if (path === home) return "~";
  if (path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
  return path;
}
