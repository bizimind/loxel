/**
 * Downloads the Tombi CLI (TOML formatter, linter and language server) from
 * GitHub releases into `packages/loxel/build/tombi` so it can ship alongside
 * `loxel-server` via electron-builder extraResources. Loxel runs it as
 * `tombi lsp`.
 *
 * `language-servers/tombi.json` pins the archive for each Rust target (see pinned-download.ts).
 */

import path from "node:path";

import { BUILD_DIR, downloadReleaseBinary, rustTarget } from "./download-release-binary";
import { manifestFile, manifestVersion } from "./language-server-manifest";

const VERSION = await manifestVersion("tombi");
// Tombi publishes only static musl builds for Linux.
const target = rustTarget("musl");
const isWindows = process.platform === "win32";
// Windows releases are a zip with `tombi.exe` at the root; the others a tarball with
// `tombi-cli-<version>-<target>/tombi`.
const archiveBase = `tombi-cli-${VERSION}-${target}`;
const { url, sha256 } = await manifestFile("tombi", `${target}${isWindows ? ".zip" : ".tar.gz"}`);

await downloadReleaseBinary({
  name: "tombi",
  url,
  sha256,
  member: isWindows ? "tombi.exe" : `${archiveBase}/tombi`,
  outBinary: path.join(BUILD_DIR, isWindows ? "tombi.exe" : "tombi"),
});
