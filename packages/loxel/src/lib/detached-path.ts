/** Get the display filename from an absolute or relative file path. */
export function getDisplayFilename(filePath: string): string {
  return filePath.split("/").pop() ?? filePath;
}

/**
 * Normalize a directory path to absolute by prepending the worktree root if needed.
 * Already-absolute paths (starting with `/`) pass through unchanged.
 */
export function toAbsoluteDir(dir: string, worktreePath: string | null): string {
  if (dir.startsWith("/")) return dir;
  return dir && worktreePath ? `${worktreePath}/${dir}` : (worktreePath ?? "");
}
