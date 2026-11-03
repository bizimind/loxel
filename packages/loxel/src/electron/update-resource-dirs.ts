import fs from "node:fs";

/**
 * The resource directories in `dir`, which an in-place update replaces wholesale instead of
 * extracting over, so files dropped by the new version do not linger (stale typeshed stubs would
 * shadow the bundled ones, stale jars next to new ones break jdtls). They are whatever earlier
 * updates installed: the renderer and every directory a language server's manifest stages, plus
 * any a later version no longer ships, such as the preview era's `tsgo-lib`, which is removed on
 * success while the backup keeps a rollback path. Empty when `dir` does not exist.
 */
export function updateResourceDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return [];
    throw err;
  }
}
