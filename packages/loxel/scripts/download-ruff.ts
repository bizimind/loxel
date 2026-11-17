/**
 * Downloads Astral's `ruff` binary from GitHub releases into
 * `packages/loxel/build/ruff` so it can ship alongside `loxel-server` via
 * electron-builder extraResources. Loxel runs it as `ruff server` when the
 * project's Python environment has no ruff of its own.
 *
 * The archive for each Rust target is pinned by SHA256 in `language-servers/ruff.json`, which
 * Renovate bumps (renovate.json).
 */

import path from "node:path";

import { BUILD_DIR, downloadReleaseBinary, rustTarget } from "./download-release-binary";
import { manifestSha256, manifestVersion } from "./language-server-manifest";

const VERSION = await manifestVersion("ruff");
const target = rustTarget("gnu");
const sha256 = await manifestSha256("ruff", target);

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
