/**
 * Downloads Astral's `ruff` binary from GitHub releases into
 * `packages/loxel/build/ruff` so it can ship alongside `loxel-server` via
 * electron-builder extraResources. Loxel runs it as `ruff server` when the
 * project's Python environment has no ruff of its own.
 *
 * SHA256 digests are pinned per platform from the release assets.
 */

import path from "node:path";

import { BUILD_DIR, downloadReleaseBinary, rustTarget } from "./download-release-binary";

const VERSION = "0.17.2";

/** Pinned SHA256 digests of the archives from the 0.17.2 release, by Rust target. */
const SHA256: Record<string, string> = {
  "aarch64-apple-darwin": "94fbca85f19e8b6bb068adb7cbc9a74e3e6c01004cc67c6b00246a094ad4ccd9",
  "x86_64-apple-darwin": "db57a84e385435a2c4a7c8946e588f79b9de0851d8618a1b5d4431edfff0bf01",
  "aarch64-unknown-linux-gnu": "468f29d64949574f0d28442c02f0b4fb680cff7ba8fc26b6287a73b945308e1c",
  "x86_64-unknown-linux-gnu": "7b2e6a6e132ecf7b5fe726163b186d5d209befe93bb25f83767b2d97fbdf14e5",
  "aarch64-pc-windows-msvc": "16035dc0195c32d37c9684880024902f74e86854d59c11e65be30620afac6eb4",
  "x86_64-pc-windows-msvc": "6f4de58abd7c8de2e8702a89fc0f221e6ca858ad23e25c658c707d83a48c79a0",
};

const target = rustTarget("gnu");
const sha256 = SHA256[target];
if (!sha256) {
  console.error(`No pinned SHA256 for target ${target}`);
  process.exit(1);
}

const isWindows = process.platform === "win32";
// Windows releases are a zip with `ruff.exe` at the root; the others a tarball with `ruff-<target>/ruff`.
const archiveName = isWindows ? `ruff-${target}.zip` : `ruff-${target}.tar.gz`;

await downloadReleaseBinary({
  name: "ruff",
  url: `https://github.com/astral-sh/ruff/releases/download/${VERSION}/${archiveName}`,
  sha256,
  member: isWindows ? "ruff.exe" : `ruff-${target}/ruff`,
  outBinary: path.join(BUILD_DIR, isWindows ? "ruff.exe" : "ruff"),
});
