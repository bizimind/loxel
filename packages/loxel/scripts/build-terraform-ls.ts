/**
 * Builds HashiCorp's `terraform-ls` from source into `packages/loxel/build/terraform-ls` so it can
 * ship alongside `loxel-server` via electron-builder extraResources.
 *
 * Built with Loxel's pinned Go toolchain rather than downloaded, so a `GO_VERSION` bump brings
 * standard library fixes to terraform-ls as it does to gopls and docker-language-server. HashiCorp's
 * release binaries also embed Algolia credentials, which turn on a Terraform Registry module search
 * while completing a module `source`; built without them, that search is never enabled.
 *
 * terraform-ls and its dependencies are pinned by the go.mod and go.sum in `terraform-ls-module/`.
 * The server reports the version embedded from its own `version/VERSION`, so no `-X` flag is needed.
 *
 * To upgrade: in a module with a `tools.go` importing `github.com/hashicorp/terraform-ls`, run
 * `go get github.com/hashicorp/terraform-ls@<version>`, raise any dependency a scan of the built
 * binary flags with `go get <module>@<version>`, then `go mod tidy`.
 */

import path from "node:path";

import { BUILD_DIR } from "./download-release-binary";
import { buildPinnedGoModule } from "./go-toolchain";

await buildPinnedGoModule({
  moduleDir: path.join(import.meta.dir, "terraform-ls-module"),
  pkg: "github.com/hashicorp/terraform-ls",
  outBinary: path.join(
    BUILD_DIR,
    process.platform === "win32" ? "terraform-ls.exe" : "terraform-ls",
  ),
  ldflags: "-s -w",
});
