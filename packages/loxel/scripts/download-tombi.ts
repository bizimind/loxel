/**
 * Downloads the Tombi CLI (TOML formatter, linter and language server) from
 * GitHub releases into `packages/loxel/build/tombi` so it can ship alongside
 * `loxel-server` via electron-builder extraResources. Loxel runs it as
 * `tombi lsp`.
 *
 * SHA256 digests are pinned per platform from the release assets.
 */

import path from "node:path";

import { BUILD_DIR, downloadReleaseBinary, rustTarget } from "./download-release-binary";

const VERSION = "1.9.6";

/** Pinned SHA256 digests of the archives from the v1.9.6 release, by Rust target. */
const SHA256: Record<string, string> = {
  "aarch64-apple-darwin": "e3e29db219a07e2e8534735a61c340f1bb3ec1bee845a4fcd6d72f59e0e9383e",
  "x86_64-apple-darwin": "8f9b2e3ba04f2d2773b15211024233a89d6ba0e1732c6b9d0b5f98a06ab2bd75",
  "aarch64-unknown-linux-musl": "e29f2af283d9c090c7da16468406ffa5b7183d06cefeae19da40ac6d70ffc42c",
  "x86_64-unknown-linux-musl": "a845f9275c83ee8ce408cc16fee11a7dbe5009214a4b92f2bbac5c0aa3afafe3",
  "aarch64-pc-windows-msvc": "c86f4926776c251f9d82946c470f6c33d61a597d055bf1861d3630a38cab9f59",
  "x86_64-pc-windows-msvc": "6080696714182be2e35bd89e3bbe4f301f92fb2cb888088fd282c341a4f1e5c1",
};

// Tombi publishes only static musl builds for Linux.
const target = rustTarget("musl");
const sha256 = SHA256[target];
if (!sha256) {
  console.error(`No pinned SHA256 for target ${target}`);
  process.exit(1);
}

const isWindows = process.platform === "win32";
// Windows releases are a zip with `tombi.exe` at the root; the others a tarball with
// `tombi-cli-<version>-<target>/tombi`.
const archiveBase = `tombi-cli-${VERSION}-${target}`;
const archiveName = isWindows ? `${archiveBase}.zip` : `${archiveBase}.tar.gz`;

await downloadReleaseBinary({
  name: "tombi",
  url: `https://github.com/tombi-toml/tombi/releases/download/v${VERSION}/${archiveName}`,
  sha256,
  member: isWindows ? "tombi.exe" : `${archiveBase}/tombi`,
  outBinary: path.join(BUILD_DIR, isWindows ? "tombi.exe" : "tombi"),
});
