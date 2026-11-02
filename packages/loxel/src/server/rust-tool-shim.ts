import { realpath } from "node:fs/promises";
import path from "node:path";

const VERSION_MANAGERS = new Set(["mise", "rtx", "volta-shim"]);

/**
 * Whether a tool on the lookup path is a version manager's shim rather than the tool: a script, as
 * asdf's are, or a link to mise or Volta. Real rustup proxies and compilers are binaries. Anything
 * that cannot be read counts, so it is not run.
 */
export async function isVersionManagerShim(filePath: string): Promise<boolean> {
  try {
    if (await linksToVersionManager(filePath)) return true;
    return (await Bun.file(filePath).slice(0, 2).text()) === "#!";
  } catch {
    return true;
  }
}

/** Whether a tool is a link to mise or Volta. A script is not told apart here, as tools can be one. */
export async function linksToVersionManager(filePath: string): Promise<boolean> {
  const real = await realpath(filePath).catch(() => filePath);
  return VERSION_MANAGERS.has(path.basename(real));
}
