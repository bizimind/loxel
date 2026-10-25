/**
 * Downloads Astral's `ruff` binary from GitHub releases into
 * `packages/loxel/build/ruff` so it can ship alongside `loxel-server` via
 * electron-builder extraResources. Loxel runs it as `ruff server` when the
 * project's Python environment has no ruff of its own.
 *
 * SHA256 digests are pinned per platform from the release assets. The archive
 * is verified in memory before anything is extracted, and only the binary is
 * extracted from it.
 */

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import path from "node:path";

const VERSION = "0.17.2";
const LOXEL = path.resolve(import.meta.dir, "..");
const OUTDIR = path.join(LOXEL, "build");

/** Pinned SHA256 digests of the archives from the 0.17.2 release, by Rust target. */
const SHA256: Record<string, string> = {
  "aarch64-apple-darwin": "94fbca85f19e8b6bb068adb7cbc9a74e3e6c01004cc67c6b00246a094ad4ccd9",
  "x86_64-apple-darwin": "db57a84e385435a2c4a7c8946e588f79b9de0851d8618a1b5d4431edfff0bf01",
  "aarch64-unknown-linux-gnu": "468f29d64949574f0d28442c02f0b4fb680cff7ba8fc26b6287a73b945308e1c",
  "x86_64-unknown-linux-gnu": "7b2e6a6e132ecf7b5fe726163b186d5d209befe93bb25f83767b2d97fbdf14e5",
  "aarch64-pc-windows-msvc": "16035dc0195c32d37c9684880024902f74e86854d59c11e65be30620afac6eb4",
  "x86_64-pc-windows-msvc": "6f4de58abd7c8de2e8702a89fc0f221e6ca858ad23e25c658c707d83a48c79a0",
};

function rustTarget(): string {
  const arch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : "";
  const os =
    process.platform === "darwin"
      ? "apple-darwin"
      : process.platform === "linux"
        ? "unknown-linux-gnu"
        : process.platform === "win32"
          ? "pc-windows-msvc"
          : "";
  return `${arch}-${os}`;
}

const target = rustTarget();
const expectedHash = SHA256[target];
if (!expectedHash) {
  console.error(`No pinned SHA256 for target ${target}`);
  process.exit(1);
}

const isWindows = process.platform === "win32";
const outBinary = path.join(OUTDIR, isWindows ? "ruff.exe" : "ruff");
// Windows releases are a zip with `ruff.exe` at the root; the others a tarball with `ruff-<target>/ruff`.
const archiveName = isWindows ? `ruff-${target}.zip` : `ruff-${target}.tar.gz`;
const member = isWindows ? "ruff.exe" : `ruff-${target}/ruff`;
const url = `https://github.com/astral-sh/ruff/releases/download/${VERSION}/${archiveName}`;

if (existsSync(outBinary)) {
  console.log(`ruff already present at ${outBinary}, skipping download`);
  process.exit(0);
}

mkdirSync(OUTDIR, { recursive: true });

console.log(`Downloading ${url}`);
const res = await fetch(url);
if (!res.ok) {
  console.error(`Download failed: ${res.status} ${res.statusText}`);
  process.exit(1);
}

const bytes = new Uint8Array(await res.arrayBuffer());
const actualHash = createHash("sha256").update(bytes).digest("hex");
if (actualHash !== expectedHash) {
  console.error(`SHA256 mismatch!\n  expected: ${expectedHash}\n  actual:   ${actualHash}`);
  process.exit(1);
}

// Extract in a scratch directory of its own, so nothing but the binary reaches `build/`.
const scratch = mkdtempSync(path.join(OUTDIR, "ruff-download-"));
const fail = (message: string): never => {
  rmSync(scratch, { recursive: true, force: true });
  console.error(message);
  process.exit(1);
};
const archivePath = path.join(scratch, archiveName);
await Bun.write(archivePath, bytes);
console.log("Extracting (SHA256 verified)...");
// bsdtar (macOS, Windows) reads zips too; GNU tar on Linux only gets tarballs.
const tar = Bun.spawn(["tar", "-xf", archivePath, "-C", scratch, member], {
  stdout: "inherit",
  stderr: "inherit",
});
if ((await tar.exited) !== 0) fail("tar failed");
const extracted = path.join(scratch, member);
if (!existsSync(extracted)) fail(`Expected ${extracted} after extraction but it was not found`);
renameSync(extracted, outBinary);
chmodSync(outBinary, 0o755);
rmSync(scratch, { recursive: true, force: true });
console.log(`Installed: ${outBinary}`);
