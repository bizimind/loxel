/**
 * The Go toolchain language servers built from source compile with, so those builds need no Go
 * install. go-toolchain.json pins its version and archives by SHA256 (see pinned-download.ts), and
 * it is downloaded into `build/`, so a toolchain bump brings Go's own fixes to every Go server. Which
 * modules a server compiles is its own release's business: `installGoPackage` builds exactly what the
 * release's go.mod requires.
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
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

// A read-only module cache would make the cache directory hard to delete.
const GOFLAGS = "-modcacherw";
const CGO_ENABLED = "0";

export interface GoInstall {
  /** Import path of the main package to build. */
  pkg: string;
  /** Path of the module that provides `pkg`. */
  module: string;
  /** Version of `module`, without the leading `v`. */
  version: string;
  outBinary: string;
  ldflags: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Builds `pkg` at `version` with the pinned toolchain through `go install pkg@version` outside any
 * module, so the binary links exactly the module versions the release's own go.mod requires, every
 * one checked against the Go checksum database. The build reads and leaves nothing in the machine's
 * own Go setup: the toolchain and caches stay in `build/`. Skips the build when `outBinary` was
 * built from the same toolchain, version and flags.
 */
export async function installGoPackage(build: GoInstall): Promise<void> {
  const name = path.basename(build.outBinary);
  const target = `${build.pkg}@v${build.version}`;
  const flags = ["-trimpath", `-ldflags=${build.ldflags}`];
  const source = createHash("sha256")
    .update(JSON.stringify([GO_VERSION, target, flags, GOFLAGS, CGO_ENABLED]))
    .digest("hex");
  if (installedFrom(build.outBinary, source)) {
    console.log(`${name} already built at ${build.outBinary}, skipping`);
    return;
  }

  const { goRoot, go } = await ensureGoToolchain();
  const home = path.join(BUILD_DIR, "go-home");
  mkdirSync(home, { recursive: true });
  // An empty directory, outside any module, that `go install` puts the binary in.
  const workDir = mkdtempSync(path.join(BUILD_DIR, `${name}-build-`));
  // Nothing of the machine's own Go setup: no `go env` file, GOFLAGS, GOPROXY, GONOSUMDB, GOPRIVATE
  // or GOWORK. The proxy and CA settings only decide how modules are fetched; the checksum database
  // checks them all.
  const env = {
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
    GOSUMDB: "sum.golang.org",
    GOROOT: goRoot,
    GOPATH: path.join(BUILD_DIR, "go-path"),
    GOCACHE: path.join(BUILD_DIR, "go-cache"),
    GOBIN: workDir,
    GOFLAGS,
    CGO_ENABLED,
  };
  const runGo = async (args: string[], stdout: "inherit" | "pipe"): Promise<string> => {
    const proc = Bun.spawn([go, ...args], { cwd: workDir, stdout, stderr: "inherit", env });
    const [out, code] = await Promise.all([
      proc.stdout ? new Response(proc.stdout).text() : "",
      proc.exited,
    ]);
    if (code !== 0) throw new Error(`go ${args.join(" ")} exited with ${code}`);
    return out;
  };
  try {
    console.log(`Building ${target} with Go ${GO_VERSION}...`);
    await runGo(["install", ...flags, target], "inherit");
    // `go install` names the binary after the package's last path element.
    const built = path.join(workDir, `${path.basename(build.pkg)}${ext}`);
    const info: unknown = JSON.parse(await runGo(["version", "-m", "-json", built], "pipe"));
    const main = isRecord(info) && isRecord(info.Main) ? info.Main : undefined;
    // The exact module and version, since a parent module can provide the same package path and
    // `go install` also takes a version query such as `v0.24`; the sum shows it came verified.
    if (
      main?.Path !== build.module ||
      main.Version !== `v${build.version}` ||
      typeof main.Sum !== "string" ||
      !main.Sum.startsWith("h1:")
    ) {
      throw new Error(`${name} does not record ${build.module}@v${build.version} as its module`);
    }
    renameSync(built, build.outBinary);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
  recordInstalledFrom(build.outBinary, source);
  console.log(`Installed: ${build.outBinary}`);
}
