/**
 * Builds `gopls` from source into `packages/loxel/build/gopls` so it can ship alongside
 * `loxel-server` via electron-builder extraResources, since gopls publishes no release binaries.
 *
 * Built with `installGoPackage`, so it compiles with Loxel's pinned Go toolchain and exactly the
 * modules gopls's own release requires. Upgrading gopls is its `version` in
 * `language-servers/gopls.json`, which Renovate raises.
 */

import path from "node:path";

import { BUILD_DIR } from "./download-release-binary";
import { installGoPackage } from "./go-toolchain";
import { manifestVersion } from "./language-server-manifest";

await installGoPackage({
  pkg: "golang.org/x/tools/gopls",
  module: "golang.org/x/tools/gopls",
  version: await manifestVersion("gopls"),
  outBinary: path.join(BUILD_DIR, process.platform === "win32" ? "gopls.exe" : "gopls"),
  ldflags: "-s -w",
});
