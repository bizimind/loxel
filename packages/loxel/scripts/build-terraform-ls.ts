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
 * The module names terraform-ls in a `tool` directive, so `go mod tidy` keeps its requirements,
 * and Dependabot raises its dependencies (.github/dependabot.yml). To upgrade terraform-ls itself,
 * run `go get github.com/hashicorp/terraform-ls@<version>` in the module directory, raise any
 * dependency a scan of the built binary flags with `go get <module>@<version>`, then
 * `go mod tidy`, and set the same version in `language-servers/terraform-ls.json`.
 */

import path from "node:path";

import { BUILD_DIR } from "./download-release-binary";
import { buildPinnedGoModule } from "./go-toolchain";
import { pinnedGoModuleVersion } from "./language-server-manifest";

const MODULE_DIR = path.join(import.meta.dir, "terraform-ls-module");
await pinnedGoModuleVersion("terraform-ls", MODULE_DIR, "github.com/hashicorp/terraform-ls");

await buildPinnedGoModule({
  moduleDir: MODULE_DIR,
  pkg: "github.com/hashicorp/terraform-ls",
  outBinary: path.join(
    BUILD_DIR,
    process.platform === "win32" ? "terraform-ls.exe" : "terraform-ls",
  ),
  ldflags: "-s -w",
});
