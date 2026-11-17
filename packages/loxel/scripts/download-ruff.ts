/**
 * Downloads Astral's `ruff` binary from GitHub releases into
 * `packages/loxel/build/ruff` so it can ship alongside `loxel-server` via
 * electron-builder extraResources. Loxel runs it as `ruff server` when the
 * project's Python environment has no ruff of its own.
 *
 * `language-servers/ruff.json` pins the archive for each Rust target (see pinned-download.ts).
 */

import path from "node:path";

import { BUILD_DIR, downloadReleaseBinary, rustTarget } from "./download-release-binary";
import { manifestFile } from "./language-server-manifest";

const target = rustTarget("gnu");
const isWindows = process.platform === "win32";
// Windows releases are a zip with `ruff.exe` at the root; the others a tarball with `ruff-<target>/ruff`.
const { url, sha256 } = await manifestFile("ruff", `${target}${isWindows ? ".zip" : ".tar.gz"}`);

await downloadReleaseBinary({
  name: "ruff",
  url,
  sha256,
  member: isWindows ? "ruff.exe" : `ruff-${target}/ruff`,
  outBinary: path.join(BUILD_DIR, isWindows ? "ruff.exe" : "ruff"),
});
