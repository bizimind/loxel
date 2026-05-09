/**
 * Copies the platform-specific `tsgo` native binary plus its sibling `lib.*.d.ts`
 * bundle into `packages/loxel/build/tsgo-lib/` so it can be shipped alongside
 * `loxel-server` in both the Electron bundle (via electron-builder extraResources)
 * and the in-app upgrade archive (staged by release-loxel.yml).
 *
 * tsgo is version-coupled to loxel-server: the LSP protocol surface and flags
 * must match what `ts-lsp-manager.ts` expects, so it ships in lockstep.
 *
 * The entire `lib/` directory is copied — not just the binary — because tsgo is
 * a Go program that reads sibling built-in lib `.d.ts` files at runtime.
 */

import { chmodSync, cpSync, existsSync, rmSync } from "node:fs";
import path from "node:path";

const LOXEL = path.resolve(import.meta.dir, "..");
const OUTDIR = path.join(LOXEL, "build");
const exeName = process.platform === "win32" ? "tsgo.exe" : "tsgo";

// `@typescript/native-preview` is the installable package; the platform binary lives
// in `@typescript/native-preview-<platform>-<arch>`, declared as an optional dep of
// the former. Resolve it relative to the native-preview package dir so bun finds it
// regardless of hoist layout (works on both dev machines and CI runners).
const nativePreviewPkgJson = Bun.resolveSync(
  "@typescript/native-preview/package.json",
  process.cwd(),
);
const nativePreviewDir = path.dirname(nativePreviewPkgJson);

const platformPkg = `@typescript/native-preview-${process.platform}-${process.arch}`;
let platformPkgJson: string;
try {
  platformPkgJson = Bun.resolveSync(`${platformPkg}/package.json`, nativePreviewDir);
} catch {
  console.error(
    `Could not resolve ${platformPkg}. Is your platform/arch supported by @typescript/native-preview?`,
  );
  process.exit(1);
}

const srcLibDir = path.join(path.dirname(platformPkgJson), "lib");
if (!existsSync(path.join(srcLibDir, exeName))) {
  console.error(`tsgo binary not found at ${srcLibDir}/${exeName}`);
  process.exit(1);
}

const dstDir = path.join(OUTDIR, "tsgo-lib");
rmSync(dstDir, { recursive: true, force: true });
cpSync(srcLibDir, dstDir, { recursive: true });
chmodSync(path.join(dstDir, exeName), 0o755);

console.log(`Copied tsgo dir: ${srcLibDir} -> ${dstDir}`);
