/**
 * The Go toolchain language servers built from source compile with, so those builds need no Go
 * install. It is pinned by SHA256 and downloaded into `build/`.
 */

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import path from "node:path";

import { BUILD_DIR, downloadReleaseBinary } from "./download-release-binary";

export const GO_VERSION = "1.27.4";

/** Pinned SHA256 digests from https://go.dev/dl/?mode=json */
const GO_SHA256: Record<string, string> = {
  "darwin-amd64": "2b799377704ef12db39bd254995d5c348c9cc8d86562ca817724390e56c38f43",
  "darwin-arm64": "91a44a2b8a716600ad94a4f143e156116620db8828086a6e3602291be9bd0bb4",
  "linux-amd64": "7226736c2339719cda28fbf3a54d71aa63bcefe376e98cef00034268dab24840",
  "linux-arm64": "3392582988a273a87ab5043ee1b2c9c17a2c3c00580bf9326c47a2e0aaaeac92",
  "windows-amd64": "178ab98950ac69ab25069307dc6ade79f3816e414cce95b4da166a115cde1e7e",
  "windows-arm64": "9e7a72565792b8ab370b37ac9ac109799237abacb39ff2f541c438b963c0cc64",
};

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
  const platform = goPlatform();
  const sha256 = GO_SHA256[platform];
  if (!sha256) throw new Error(`No pinned Go toolchain for platform ${platform}`);

  const goRoot = path.join(BUILD_DIR, `go-${GO_VERSION}`);
  await downloadReleaseBinary({
    name: "go",
    url: `https://go.dev/dl/go${GO_VERSION}.${platform}${ext ? ".zip" : ".tar.gz"}`,
    sha256,
    member: "go",
    outBinary: goRoot,
  });
  return { goRoot, go: path.join(goRoot, "bin", `go${ext}`) };
}

const MODULE_FILES = ["go.mod", "go.sum"];

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
  // Records what `outBinary` was built from: one from an older checkout must not be kept.
  const stampFile = `${build.outBinary}.source`;
  const hash = createHash("sha256").update(`${GO_VERSION}\0${build.pkg}\0${build.ldflags}`);
  for (const file of MODULE_FILES) {
    hash.update(await Bun.file(path.join(build.moduleDir, file)).text());
  }
  const stamp = hash.digest("hex");

  const stamped = Bun.file(stampFile);
  if (existsSync(build.outBinary) && (await stamped.exists()) && (await stamped.text()) === stamp) {
    console.log(`${name} already built at ${build.outBinary}, skipping`);
    return;
  }
  rmSync(stampFile, { force: true });

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
    const proc = Bun.spawn(
      [go, "build", "-trimpath", `-ldflags=${build.ldflags}`, "-o", tmpBinary, build.pkg],
      {
        cwd: moduleDir,
        stdout: "inherit",
        stderr: "inherit",
        // Nothing of the machine's own Go setup: no `go env` file, GOFLAGS, GOPROXY or GOWORK.
        env: {
          PATH: process.env.PATH,
          TMPDIR: process.env.TMPDIR,
          TMP: process.env.TMP,
          TEMP: process.env.TEMP,
          SYSTEMROOT: process.env.SYSTEMROOT,
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
          // A read-only module cache would make the cache directory hard to delete.
          GOFLAGS: "-modcacherw -mod=readonly",
          CGO_ENABLED: "0",
        },
      },
    );
    if ((await proc.exited) !== 0) throw new Error(`go build of ${build.pkg} failed`);
    renameSync(tmpBinary, build.outBinary);
  } finally {
    rmSync(moduleDir, { recursive: true, force: true });
  }
  await Bun.write(stampFile, stamp);
  console.log(`Installed: ${build.outBinary}`);
}
