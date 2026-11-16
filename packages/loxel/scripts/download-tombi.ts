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
import { manifestVersion } from "./language-server-manifest";

const VERSION = await manifestVersion("tombi");

/** Pinned SHA256 digests of the archives from the manifest version's release, by Rust target. */
const SHA256: Record<string, string> = {
  "aarch64-apple-darwin": "4e7daae9197910fe3717d241e5ca85cafd0f7f0ead988056fdd0b2cf2a447600",
  "x86_64-apple-darwin": "642900713c3cb04adf45264117649e5f4731395b62cbafee8a9a2824fa479684",
  "aarch64-unknown-linux-musl": "083614471a69e15f147ba68c96fe1e3ea02e8efe38d6bcdb4606b5a37ab8758a",
  "x86_64-unknown-linux-musl": "36672279d05f093455f01fa5a2799a8cc2162a9195cbbb23f0f8d1107d0de497",
  "aarch64-pc-windows-msvc": "621bf39b23546ecf9b2b4759f4203d6c5040a40ccd2abe17fa731999de1f81f0",
  "x86_64-pc-windows-msvc": "b6b2d9e6419216aaa0b8e74a5c81c48335cb193d6eb87f50a7d77468bce10073",
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
