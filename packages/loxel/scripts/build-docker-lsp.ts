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

import { BUILD_DIR, downloadReleaseBinary } from "./download-release-binary";

const VERSION = "v0.20.1";
const MODULE = "github.com/docker/docker-language-server";
const MODULE_HASH = "h1:kuhe8i2RshkBgVGujAfoquc/XMbM9LZJbewfwhdQ9Sk=";

const GO_VERSION = "1.27.3";
/** Pinned SHA256 digests from https://go.dev/dl/?mode=json */
const GO_SHA256: Record<string, string> = {
  "darwin-amd64": "b6f8e931e4ab497fcde6da8ae4499a58f9d258e55c8a80824a516eae5950a750",
  "darwin-arm64": "dd3908cf20959d798c1e06ebe5b72213f0505ce01373b40ce3110975a6cd99c2",
  "linux-amd64": "65efbc80fdc1fa2cd2631cad5b481777a68e8725f34e89f50fc6ac714e379b40",
  "linux-arm64": "a06e99309dbcbdca1a8ccd2282c3ee146e55930886e26b4f1193269587165f49",
  "windows-amd64": "f26081f438319757f8a1b46d7d0b2c5ec7583d4038e485e0aa725cfde7885fff",
  "windows-arm64": "c507872ff21f8a7cd3c1c217b059c6f7271a4a9d8e692810ef9dd3e1f601197c",
};

function goPlatform(): string {
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "amd64" : process.arch;
  const os = process.platform === "win32" ? "windows" : process.platform;
  return `${os}-${arch}`;
}

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

const platform = goPlatform();
const goSha256 = GO_SHA256[platform];
if (!goSha256) throw new Error(`No pinned Go toolchain for platform ${platform}`);

const goRoot = path.join(BUILD_DIR, `go-${GO_VERSION}`);
await downloadReleaseBinary({
  name: "go",
  url: `https://go.dev/dl/go${GO_VERSION}.${platform}${ext ? ".zip" : ".tar.gz"}`,
  sha256: goSha256,
  member: "go",
  outBinary: goRoot,
});
const go = path.join(goRoot, "bin", `go${ext}`);

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
