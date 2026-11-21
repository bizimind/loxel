/** Whether a path lies in a directory, by path alone, and `PATH` without a worktree's directories. */
import path from "node:path";

/** Whether `child` is `parent` or inside it, comparing the paths as given: links are not resolved. */
export function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return !path.isAbsolute(relative) && relative.split(path.sep)[0] !== "..";
}

/**
 * `PATH` with only absolute directories outside the worktree, for processes that look up a tool
 * themselves, so they cannot pick up one the repository ships. A relative entry goes whatever it
 * names, since it resolves against whichever directory the process runs in.
 */
export function pathOutsideWorktree(PATH: string, wtPath: string): string {
  const root = path.resolve(wtPath);
  return PATH.split(path.delimiter)
    .filter((dir) => path.isAbsolute(dir) && !isInside(path.resolve(dir), root))
    .join(path.delimiter);
}
