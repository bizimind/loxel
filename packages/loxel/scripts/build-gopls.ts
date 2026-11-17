/**
 * Builds `gopls` from source into `packages/loxel/build/gopls` so it can ship alongside
 * `loxel-server` via electron-builder extraResources, since gopls publishes no release binaries.
 *
 * gopls and its dependencies are pinned by the go.mod and go.sum in `gopls-module/`.
 *
 * To upgrade: regenerate the module files with `go get golang.org/x/tools/gopls@<version>` and
 * `go mod tidy` in a module with a `tools.go` importing gopls.
 */

import path from "node:path";

import { BUILD_DIR } from "./download-release-binary";
import { buildPinnedGoModule } from "./go-toolchain";

await buildPinnedGoModule({
  moduleDir: path.join(import.meta.dir, "gopls-module"),
  pkg: "golang.org/x/tools/gopls",
  outBinary: path.join(BUILD_DIR, process.platform === "win32" ? "gopls.exe" : "gopls"),
  ldflags: "-s -w",
});
