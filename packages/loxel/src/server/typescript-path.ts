import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Locate the official TypeScript 7 native compiler.
 *
 * TypeScript 7 ships a Node shim that selects a platform package. The native compiler
 * loads sibling library declarations, so we ship the whole `lib/` directory.
 */
export function resolveTypeScriptBinary(): string | null {
  const exeName = process.platform === "win32" ? "tsc.exe" : "tsc";
  const execDir = path.dirname(process.execPath);

  // Shipped alongside loxel-server: `typescript-lib/<exe>` (with `lib.*.d.ts` siblings).
  const packaged = path.join(execDir, "typescript-lib", exeName);
  if (existsSync(packaged)) return packaged;

  // Dev mode: locate TypeScript 7's Node shim, which selects the platform binary.
  try {
    const pkgJson = Bun.resolveSync("@typescript/native/package.json", import.meta.dir);
    const shim = path.join(path.dirname(pkgJson), "bin", "tsc");
    if (existsSync(shim)) return shim;
  } catch {
    // Not installed in a resolvable location.
  }

  return null;
}
