/**
 * Copies the platform-specific TypeScript 7 `tsc` binary plus its sibling libraries
 * into `packages/loxel/build/typescript-lib/` so it can be shipped alongside
 * `loxel-server` in both the Electron bundle (via electron-builder extraResources)
 * and the in-app upgrade archive (staged by release-loxel.yml).
 *
 * TypeScript is version-coupled to loxel-server: the LSP protocol surface and flags
 * must match what `ts-lsp-manager.ts` expects, so it ships in lockstep.
 *
 * The entire `lib/` directory is copied because the native compiler reads its sibling
 * built-in library declarations at runtime.
 */

import { chmodSync, cpSync, existsSync, rmSync } from "node:fs";
import path from "node:path";

const LOXEL = path.resolve(import.meta.dir, "..");
const OUTDIR = path.join(LOXEL, "build");
const exeName = process.platform === "win32" ? "tsc.exe" : "tsc";

// TypeScript 7 delegates to a platform package declared as an optional dependency.
// Resolve it relative to the aliased TypeScript package so this works with pnpm's
// isolated layout on developer machines and CI runners.
const typescriptPkgJson = Bun.resolveSync("@typescript/native/package.json", process.cwd());
const typescriptDir = path.dirname(typescriptPkgJson);

const platformPkg = `@typescript/typescript-${process.platform}-${process.arch}`;
let platformPkgJson: string;
try {
  platformPkgJson = Bun.resolveSync(`${platformPkg}/package.json`, typescriptDir);
} catch {
  console.error(
    `Could not resolve ${platformPkg}. Is your platform/arch supported by TypeScript 7?`,
  );
  process.exit(1);
}

const srcLibDir = path.join(path.dirname(platformPkgJson), "lib");
if (!existsSync(path.join(srcLibDir, exeName))) {
  console.error(`TypeScript compiler not found at ${srcLibDir}/${exeName}`);
  process.exit(1);
}

const dstDir = path.join(OUTDIR, "typescript-lib");
rmSync(dstDir, { recursive: true, force: true });
cpSync(srcLibDir, dstDir, { recursive: true });
chmodSync(path.join(dstDir, exeName), 0o755);

console.log(`Copied TypeScript 7 runtime: ${srcLibDir} -> ${dstDir}`);
