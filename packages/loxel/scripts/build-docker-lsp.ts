/**
 * Builds Docker's `docker-language-server` from source into
 * `packages/loxel/build/docker-language-server` so it can ship alongside
 * `loxel-server` via electron-builder extraResources.
 *
 * Docker's release binaries embed its telemetry and BugSnag keys at build time and contact those
 * services whatever the server is configured to do. Built without the keys, both clients have
 * nowhere to send anything, so neither can be turned back on by a setting or a crash path.
 *
 * The server and its dependencies are pinned by the go.mod and go.sum in `docker-lsp-module/`,
 * which require a commit of its main branch and raise the dependencies its own go.mod leaves at
 * vulnerable versions.
 *
 * To upgrade: in a module with a `tools.go` importing
 * `github.com/docker/docker-language-server/cmd/docker-language-server`, run
 * `go get github.com/docker/docker-language-server/cmd/docker-language-server@<version or commit>`,
 * raise any dependency a scan of the built binary flags with `go get <module>@<version>`, then
 * `go mod tidy`.
 */

import path from "node:path";

import { BUILD_DIR } from "./download-release-binary";
import { buildPinnedGoModule } from "./go-toolchain";

const MODULE = "github.com/docker/docker-language-server";
const MODULE_DIR = path.join(import.meta.dir, "docker-lsp-module");

// The version the module pins, which the server reports as its own.
const goMod = await Bun.file(path.join(MODULE_DIR, "go.mod")).text();
const version = new RegExp(`^require ${MODULE} (\\S+)\\r?$`, "m").exec(goMod)?.[1];
if (!version) throw new Error(`docker-lsp-module/go.mod does not require ${MODULE}`);

await buildPinnedGoModule({
  moduleDir: MODULE_DIR,
  pkg: `${MODULE}/cmd/docker-language-server`,
  outBinary: path.join(
    BUILD_DIR,
    process.platform === "win32" ? "docker-language-server.exe" : "docker-language-server",
  ),
  ldflags: `-X ${MODULE}/internal/pkg/cli/metadata.Version=${version}`,
});
