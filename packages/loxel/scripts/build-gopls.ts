/**
 * Builds `gopls` from source into `packages/loxel/build/gopls` so it can ship alongside
 * `loxel-server` via electron-builder extraResources, since gopls publishes no release binaries.
 *
 * gopls and its dependencies are pinned by the go.mod and go.sum in `gopls-module/`, which the go
 * command checks every download against. The build reads and leaves nothing in the machine's own
 * Go setup: the toolchain and caches stay in `build/`.
 *
 * To upgrade: regenerate the module files with `go get golang.org/x/tools/gopls@<version>` and
 * `go mod tidy` in a module with a `tools.go` importing gopls.
 */

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import path from "node:path";

import { BUILD_DIR } from "./download-release-binary";
import { ensureGoToolchain, GO_VERSION } from "./go-toolchain";

/** Holds the go.mod and go.sum pinning gopls and its dependencies. */
const MODULE_DIR = path.join(import.meta.dir, "gopls-module");
const MODULE_FILES = ["go.mod", "go.sum"];

const outBinary = path.join(BUILD_DIR, process.platform === "win32" ? "gopls.exe" : "gopls");
// Records what `outBinary` was built from: one from an older checkout must not be kept.
const stampFile = `${outBinary}.source`;

/** Build gopls with the pinned toolchain, in a temporary copy of that module. */
async function buildGopls(): Promise<void> {
  const { goRoot, go } = await ensureGoToolchain();
  const home = path.join(BUILD_DIR, "go-home");
  mkdirSync(home, { recursive: true });
  const moduleDir = mkdtempSync(path.join(BUILD_DIR, "gopls-module-"));
  const tmpBinary = path.join(moduleDir, path.basename(outBinary));
  try {
    for (const file of MODULE_FILES) {
      cpSync(path.join(MODULE_DIR, file), path.join(moduleDir, file));
    }
    console.log("Building gopls...");
    const build = Bun.spawn(
      [go, "build", "-trimpath", "-ldflags=-s -w", "-o", tmpBinary, "golang.org/x/tools/gopls"],
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
    if ((await build.exited) !== 0) throw new Error("go build failed");
    renameSync(tmpBinary, outBinary);
  } finally {
    rmSync(moduleDir, { recursive: true, force: true });
  }
  console.log(`Installed: ${outBinary}`);
}

const hash = createHash("sha256").update(GO_VERSION);
for (const file of MODULE_FILES) {
  hash.update(await Bun.file(path.join(MODULE_DIR, file)).text());
}
const stamp = hash.digest("hex");

const stamped = Bun.file(stampFile);
if (existsSync(outBinary) && (await stamped.exists()) && (await stamped.text()) === stamp) {
  console.log(`gopls already built at ${outBinary}, skipping`);
} else {
  rmSync(stampFile, { force: true });
  await buildGopls();
  await Bun.write(stampFile, stamp);
}
