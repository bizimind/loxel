/**
 * Builds Docker's `docker-language-server` from source into
 * `packages/loxel/build/docker-language-server` so it can ship alongside
 * `loxel-server` via electron-builder extraResources.
 *
 * Docker's release binaries embed its telemetry and BugSnag keys at build time and contact those
 * services whatever the server is configured to do. Built without the keys, both clients have
 * nowhere to send anything, so neither can be turned back on by a setting or a crash path.
 *
 * Needs no Go install: a toolchain pinned by SHA256 is downloaded into `build/`. `go install`
 * verifies the module against the Go checksum database, and the result is checked against the
 * module hash pinned here.
 */

import { existsSync, rmSync } from "node:fs";
import path from "node:path";

import { $ } from "bun";

import { BUILD_DIR } from "./download-release-binary";
import { ensureGoToolchain, GO_VERSION } from "./go-toolchain";

const VERSION = "v0.20.1";
const MODULE = "github.com/docker/docker-language-server";
const MODULE_HASH = "h1:kuhe8i2RshkBgVGujAfoquc/XMbM9LZJbewfwhdQ9Sk=";

const ext = process.platform === "win32" ? ".exe" : "";
const outBinary = path.join(BUILD_DIR, `docker-language-server${ext}`);
// Records what `outBinary` was built from: one downloaded by an older checkout must not be kept.
const stampFile = `${outBinary}.source`;
const stamp = `${MODULE}@${VERSION} ${MODULE_HASH} go${GO_VERSION}`;

const stamped = Bun.file(stampFile);
if (existsSync(outBinary) && (await stamped.exists()) && (await stamped.text()) === stamp) {
  console.log(`docker-language-server ${VERSION} already built at ${outBinary}, skipping`);
  process.exit(0);
}
rmSync(stampFile, { force: true });

const { goRoot, go } = await ensureGoToolchain();

// Nothing from the caller's Go environment may weaken module verification or change the target;
// the hash check below only covers the main module, and the checksum database all its dependencies.
const goEnv = {
  ...process.env,
  CGO_ENABLED: "0",
  GOAMD64: "",
  GOARCH: "",
  GOARM64: "",
  GOBIN: BUILD_DIR,
  GOCACHE: path.join(BUILD_DIR, "go-cache"),
  // Without this, `go env -w` settings would apply wherever the entries here are empty.
  GOENV: "off",
  GOEXPERIMENT: "",
  GOFLAGS: "-modcacherw",
  GOINSECURE: "",
  GONOPROXY: "",
  GONOSUMDB: "",
  GOOS: "",
  GOPATH: path.join(BUILD_DIR, "go-path"),
  GOPRIVATE: "",
  GOROOT: goRoot,
  GOSUMDB: "sum.golang.org",
  GOTOOLCHAIN: "local",
};

console.log(`Building ${MODULE}@${VERSION} with Go ${GO_VERSION}`);
const ldflags = `-ldflags=-X ${MODULE}/internal/pkg/cli/metadata.Version=${VERSION}`;
await $`${go} install -trimpath ${ldflags} ${MODULE}/cmd/docker-language-server@${VERSION}`.env(
  goEnv,
);

const buildInfo = await $`${go} version -m ${outBinary}`.env(goEnv).text();
if (!buildInfo.includes(`mod\t${MODULE}\t${VERSION}\t${MODULE_HASH}`)) {
  throw new Error(`Built from an unexpected module, expected ${MODULE_HASH}:\n${buildInfo}`);
}

await Bun.write(stampFile, stamp);
console.log(`Installed: ${outBinary}`);
