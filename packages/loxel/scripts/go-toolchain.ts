/**
 * The Go toolchain language servers built from source compile with, so those builds need no Go
 * install. go-toolchain.json pins its version and archives by SHA256 (see pinned-download.ts), and
 * it is downloaded into `build/`.
 */

import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import path from "node:path";

import {
  BUILD_DIR,
  downloadReleaseBinary,
  installedFrom,
  recordInstalledFrom,
} from "./download-release-binary";
import { pinnedFile, readPinnedDownload } from "./pinned-download";

const PINS_FILE = path.join(import.meta.dir, "go-toolchain.json");
const PINS = readPinnedDownload(PINS_FILE, await Bun.file(PINS_FILE).json());

export const GO_VERSION = PINS.version;

function goPlatform(): string {
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "amd64" : process.arch;
  const os = process.platform === "win32" ? "windows" : process.platform;
  return `${os}-${arch}`;
}

const ext = process.platform === "win32" ? ".exe" : "";

export interface GoToolchain {
  goRoot: string;
  /** The `go` binary. */
  go: string;
}

/** The pinned toolchain, downloading it unless it is already in `build/`. */
export async function ensureGoToolchain(): Promise<GoToolchain> {
  const { url, sha256 } = pinnedFile(
    "go-toolchain",
    PINS,
    `${goPlatform()}${ext ? ".zip" : ".tar.gz"}`,
  );
  const goRoot = path.join(BUILD_DIR, `go-${GO_VERSION}`);
  await downloadReleaseBinary({ name: "go", url, sha256, member: "go", outBinary: goRoot });
  return { goRoot, go: path.join(goRoot, "bin", `go${ext}`) };
}

const MODULE_FILES = ["go.mod", "go.sum"];
// A read-only module cache would make the cache directory hard to delete.
const PINNED_BUILD_GOFLAGS = "-modcacherw -mod=readonly";
const PINNED_BUILD_CGO = "0";

export interface PinnedGoBuild {
  /** Directory holding the go.mod and go.sum that pin the program and all its dependencies. */
  moduleDir: string;
  /** Import path of the main package to build. */
  pkg: string;
  outBinary: string;
  ldflags: string;
}

/**
 * Builds `pkg` with the pinned toolchain from the module in `moduleDir`, whose go.sum the go
 * command checks every download against. The build reads and leaves nothing in the machine's own
 * Go setup: the toolchain and caches stay in `build/`. Skips the build when `outBinary` was built
 * from the same toolchain, module files and flags.
 */
export async function buildPinnedGoModule(build: PinnedGoBuild): Promise<void> {
  const name = path.basename(build.outBinary);
  const flags = ["-trimpath", `-ldflags=${build.ldflags}`];
  const hash = createHash("sha256").update(
    JSON.stringify([GO_VERSION, build.pkg, flags, PINNED_BUILD_GOFLAGS, PINNED_BUILD_CGO]),
  );
  for (const file of MODULE_FILES) {
    hash.update(await Bun.file(path.join(build.moduleDir, file)).text());
  }
  const source = hash.digest("hex");
  if (installedFrom(build.outBinary, source)) {
    console.log(`${name} already built at ${build.outBinary}, skipping`);
    return;
  }

  const { goRoot, go } = await ensureGoToolchain();
  const home = path.join(BUILD_DIR, "go-home");
  mkdirSync(home, { recursive: true });
  // A temporary copy, so the go command cannot rewrite the pinned files.
  const moduleDir = mkdtempSync(path.join(BUILD_DIR, `${name}-module-`));
  const tmpBinary = path.join(moduleDir, name);
  try {
    for (const file of MODULE_FILES) {
      cpSync(path.join(build.moduleDir, file), path.join(moduleDir, file));
    }
    console.log(`Building ${build.pkg} with Go ${GO_VERSION}...`);
    const proc = Bun.spawn([go, "build", ...flags, "-o", tmpBinary, build.pkg], {
      cwd: moduleDir,
      stdout: "inherit",
      stderr: "inherit",
      // Nothing of the machine's own Go setup: no `go env` file, GOFLAGS, GOPROXY or GOWORK.
      // The proxy and CA settings only decide how modules are fetched; go.sum checks them all.
      env: {
        PATH: process.env.PATH,
        TMPDIR: process.env.TMPDIR,
        TMP: process.env.TMP,
        TEMP: process.env.TEMP,
        SYSTEMROOT: process.env.SYSTEMROOT,
        HTTP_PROXY: process.env.HTTP_PROXY,
        HTTPS_PROXY: process.env.HTTPS_PROXY,
        NO_PROXY: process.env.NO_PROXY,
        SSL_CERT_FILE: process.env.SSL_CERT_FILE,
        SSL_CERT_DIR: process.env.SSL_CERT_DIR,
        // Where the go command keeps its own files besides those named here.
        HOME: home,
        USERPROFILE: home,
        LOCALAPPDATA: home,
        GOENV: "off",
        GOWORK: "off",
        GOTOOLCHAIN: "local",
        GOROOT: goRoot,
        GOPATH: path.join(BUILD_DIR, "go-path"),
        GOCACHE: path.join(BUILD_DIR, "go-cache"),
        GOFLAGS: PINNED_BUILD_GOFLAGS,
        CGO_ENABLED: PINNED_BUILD_CGO,
      },
    });
    if ((await proc.exited) !== 0) throw new Error(`go build of ${build.pkg} failed`);
    renameSync(tmpBinary, build.outBinary);
  } finally {
    rmSync(moduleDir, { recursive: true, force: true });
  }
  recordInstalledFrom(build.outBinary, source);
  console.log(`Installed: ${build.outBinary}`);
}
