import { readlinkSync, realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";

const VERSION_MANAGERS = new Set(["mise", "rtx", "volta-shim"]);

/** Whether a tool is a link to mise or Volta, without judging one that is a script. */
export async function linksToVersionManager(filePath: string): Promise<boolean> {
  const real = await realpath(filePath).catch(() => filePath);
  return VERSION_MANAGERS.has(path.basename(real));
}

const MAX_LINK_HOPS = 16;

/** A version manager's shim: asdf, mise, pyenv and goenv all keep theirs in a directory of this name. */
export function isShim(binary: string): boolean {
  const inShims = (file: string) => path.basename(path.dirname(file)) === "shims";
  // Each link on the way counts: mise's shims are themselves links to the `mise` binary.
  let current = binary;
  for (let hops = 0; hops < MAX_LINK_HOPS; hops++) {
    if (inShims(current)) return true;
    try {
      current = path.resolve(path.dirname(current), readlinkSync(current));
    } catch {
      break;
    }
  }
  try {
    return inShims(realpathSync(binary));
  } catch {
    return inShims(binary);
  }
}
