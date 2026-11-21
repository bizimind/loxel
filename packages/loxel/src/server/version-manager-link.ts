import { readlinkSync, realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";

const VERSION_MANAGERS = new Set(["mise", "rtx", "volta-shim"]);
const MAX_LINK_HOPS = 16;

/** Whether a tool is a link to mise or Volta, without judging one that is a script. */
export async function linksToVersionManager(filePath: string): Promise<boolean> {
  const real = await realpath(filePath).catch(() => filePath);
  return VERSION_MANAGERS.has(path.basename(real));
}

/** asdf, mise, pyenv and goenv all name their directory of shims this. */
const isShimsDir = (dir: string) => path.basename(dir) === "shims";

/** `file` and each link it leads through, by absolute path, ending at the real file. */
function linkChain(file: string): string[] {
  const chain = [path.resolve(file)];
  for (let hops = 0; hops < MAX_LINK_HOPS; hops++) {
    const current = chain.at(-1) ?? file;
    try {
      chain.push(path.resolve(path.dirname(current), readlinkSync(current)));
    } catch {
      break;
    }
  }
  try {
    const real = realpathSync(file);
    if (real !== chain.at(-1)) chain.push(real);
  } catch {
    // A broken link: the chain so far is all there is.
  }
  return chain;
}

/**
 * Whether running `file` starts a version manager that picks the program by the directory it runs
 * in: a link on the way, or the file it leads to, in a `shims` directory, or a link to mise or Volta.
 */
export function runsThroughVersionManager(file: string): boolean {
  const chain = linkChain(file);
  return (
    chain.some((link) => isShimsDir(path.dirname(link))) ||
    VERSION_MANAGERS.has(path.basename(chain.at(-1) ?? file))
  );
}

/**
 * The path to start a version manager's shim by, so it runs what `file` would: the real file, or
 * for a link to mise or Volta, which read the name they were started by, the last link before it.
 */
export function shimEntry(file: string): string {
  const chain = linkChain(file);
  const real = chain.at(-1) ?? file;
  return VERSION_MANAGERS.has(path.basename(real)) ? (chain.at(-2) ?? real) : real;
}
