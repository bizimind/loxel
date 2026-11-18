/**
 * Builds HashiCorp's `terraform-ls` from source into `packages/loxel/build/terraform-ls` so it can
 * ship alongside `loxel-server` via electron-builder extraResources.
 *
 * Built with Loxel's pinned Go toolchain rather than downloaded, so a toolchain bump brings
 * standard library fixes to terraform-ls as it does to gopls. HashiCorp's release binaries also
 * embed Algolia credentials, which turn on a Terraform Registry module search while completing a
 * module `source`; built without them, that search is never enabled.
 *
 * Built with `installGoPackage`, so it compiles exactly the modules terraform-ls's own release
 * requires. The server reports the version embedded from its own `version/VERSION`, so no `-X`
 * flag is needed. Upgrading terraform-ls is its `version` in `language-servers/terraform-ls.json`,
 * which Renovate raises.
 */

import path from "node:path";

import { BUILD_DIR } from "./download-release-binary";
import { installGoPackage } from "./go-toolchain";
import { manifestVersion } from "./language-server-manifest";

await installGoPackage({
  pkg: "github.com/hashicorp/terraform-ls",
  module: "github.com/hashicorp/terraform-ls",
  version: await manifestVersion("terraform-ls"),
  outBinary: path.join(
    BUILD_DIR,
    process.platform === "win32" ? "terraform-ls.exe" : "terraform-ls",
  ),
  ldflags: "-s -w",
});
