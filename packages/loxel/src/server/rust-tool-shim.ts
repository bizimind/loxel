import { realpath } from "node:fs/promises";
import path from "node:path";

const VERSION_MANAGERS = new Set(["mise", "rtx"]);

/**
 * Whether a tool on the lookup path is a version manager's shim rather than the tool: a script, as
 * asdf's are, or a link to mise. Real rustup proxies and compilers are binaries. Anything that
 * cannot be read counts, so it is not run.
 */
export async function isVersionManagerShim(filePath: string): Promise<boolean> {
  try {
    if (VERSION_MANAGERS.has(path.basename(await realpath(filePath)))) return true;
    return (await Bun.file(filePath).slice(0, 2).text()) === "#!";
  } catch {
    return true;
  }
}
