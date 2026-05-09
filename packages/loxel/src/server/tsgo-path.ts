import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Locate the real `tsgo` native binary.
 *
 * `@typescript/native-preview` ships a Node shim at `node_modules/.bin/tsgo` that
 * re-execs a platform-specific binary from `@typescript/native-preview-<plat>-<arch>`.
 * tsgo also loads sibling `lib.*.d.ts` files at runtime, so we ship the whole `lib/`
 * directory as `tsgo-lib/` next to `loxel-server`.
 */
export function resolveTsgoBinary(): string | null {
  const exeName = process.platform === "win32" ? "tsgo.exe" : "tsgo";
  const execDir = path.dirname(process.execPath);

  // Shipped alongside loxel-server: `tsgo-lib/<exe>` (with `lib.*.d.ts` siblings).
  const packaged = path.join(execDir, "tsgo-lib", exeName);
  if (existsSync(packaged)) return packaged;

  // Dev mode: locate `node_modules/.bin/tsgo` (a Node shim that execve's the real
  // binary) by resolving native-preview's package.json.
  try {
    const pkgJson = Bun.resolveSync("@typescript/native-preview/package.json", execDir);
    const nodeModulesDir = path.resolve(path.dirname(pkgJson), "../..");
    const shim = path.join(nodeModulesDir, ".bin", exeName);
    if (existsSync(shim)) return shim;
  } catch {
    // Not installed in a resolvable location — fall through.
  }

  return Bun.which("tsgo");
}
