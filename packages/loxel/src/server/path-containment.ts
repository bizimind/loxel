/** Whether a path lies in a directory, by path alone, and `PATH` without a worktree's directories. */
import path from "node:path";

/** Whether `child` is `parent` or inside it, comparing the paths as given: links are not resolved. */
export function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return !path.isAbsolute(relative) && relative.split(path.sep)[0] !== "..";
}

/**
 * `PATH` without the worktree's own directories, relative ones included, for processes that look
 * up a tool themselves, so they cannot pick up one the repository ships.
 */
export function pathOutsideWorktree(PATH: string, wtPath: string): string {
  const root = path.resolve(wtPath);
  return PATH.split(path.delimiter)
    .filter((dir) => dir && !isInside(path.resolve(root, dir), root))
    .join(path.delimiter);
}
