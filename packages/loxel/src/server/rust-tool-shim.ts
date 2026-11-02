import { linksToVersionManager } from "./version-manager-link";

/**
 * Whether a tool on the lookup path is a version manager's shim rather than the tool: a script, as
 * asdf's are, or a link to mise or Volta. Real rustup proxies and compilers are binaries. Anything
 * that cannot be read counts, so it is not run.
 */
export async function isVersionManagerShim(filePath: string): Promise<boolean> {
  try {
    // A link that can't be followed fails the read below, so it counts too.
    if (await linksToVersionManager(filePath)) return true;
    return (await Bun.file(filePath).slice(0, 2).text()) === "#!";
  } catch {
    return true;
  }
}
