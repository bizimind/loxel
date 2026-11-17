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

const VERSION = "0.17.5";

/** Pinned SHA256 digests of the archives from the 0.17.5 release, by Rust target. */
const SHA256: Record<string, string> = {
  "aarch64-apple-darwin": "4ffadabec5c5fee1ddb2eecac0787ffe6fa18c665b73da9258b84211f40c5829",
  "x86_64-apple-darwin": "892f70854ebcd70d873b1bee8358cfd3a1e3180388e3851e3fd3e4a1d5a4dfdd",
  "aarch64-unknown-linux-gnu": "4d959d4322a8cd3effe11e9fc6743da1dbb41cd0b2476e433b6e6bfd9a69b626",
  "x86_64-unknown-linux-gnu": "7d261fc981a784668e19e9fa6ad437bfd95b67f2dc263fc1eab87d54d72fcc90",
  "aarch64-pc-windows-msvc": "037fee4b6a171e81c910f30a6067857d254b78d4ca57eafaeead30854c15c543",
  "x86_64-pc-windows-msvc": "6e1284ce4e2fa0ea7b4a28d0947f59c63e6983aa8b2e5b04402b0e59376405ca",
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
