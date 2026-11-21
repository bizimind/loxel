import { realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";

const VERSION_MANAGERS = new Set(["mise", "rtx", "volta-shim"]);

/** Whether a tool is a link to mise or Volta, without judging one that is a script. */
export async function linksToVersionManager(filePath: string): Promise<boolean> {
  const real = await realpath(filePath).catch(() => filePath);
  return VERSION_MANAGERS.has(path.basename(real));
}

const isShimsDir = (dir: string) => path.basename(dir) === "shims";

/**
 * Whether running `file` starts a version manager that picks the program by the directory it runs
 * in: a file in a `shims` directory (asdf, mise, pyenv and goenv name theirs this), by its path or
 * where a link leads, or a link to mise or Volta.
 */
export async function runsThroughVersionManager(file: string): Promise<boolean> {
  if (isShimsDir(path.dirname(file))) return true;
  const real = await realpath(file).catch(() => file);
  return isShimsDir(path.dirname(real)) || VERSION_MANAGERS.has(path.basename(real));
}

/**
 * `PATH` without the directories of version managers' shims (asdf, mise, pyenv and goenv all name
 * theirs `shims`), by name or by where a link leads: a shim picks its version from the directory it
 * runs in.
 */
export function pathWithoutShims(PATH: string): string {
  return PATH.split(path.delimiter)
    .filter((dir) => !isShimsDir(dir) && !isShimsDir(realpathOrSelf(dir)))
    .join(path.delimiter);
}

function realpathOrSelf(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}
