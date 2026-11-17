/**
 * Downloads the Tombi CLI (TOML formatter, linter and language server) from
 * GitHub releases into `packages/loxel/build/tombi` so it can ship alongside
 * `loxel-server` via electron-builder extraResources. Loxel runs it as
 * `tombi lsp`.
 *
 * The archive for each Rust target is pinned by SHA256 in `language-servers/tombi.json`, which
 * Renovate bumps (renovate.json).
 */

import path from "node:path";

import { BUILD_DIR, downloadReleaseBinary, rustTarget } from "./download-release-binary";
import { manifestSha256, manifestVersion } from "./language-server-manifest";

const VERSION = await manifestVersion("tombi");
// Tombi publishes only static musl builds for Linux.
const target = rustTarget("musl");
const sha256 = await manifestSha256("tombi", target);

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
