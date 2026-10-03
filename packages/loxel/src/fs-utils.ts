import { statSync } from "node:fs";

/** Whether `path` exists and is a directory (following symlinks). */
export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
