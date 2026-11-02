import { existsSync, statSync } from "node:fs";
import path from "node:path";

/** Whether `path` exists and is a directory (following symlinks). */
export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The nearest `name` in `startDir` or a directory above it. */
export function findFileAbove(name: string, startDir: string): string | null {
  let current = startDir;
  for (;;) {
    const candidate = path.join(current, name);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
