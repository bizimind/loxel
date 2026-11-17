/**
 * Downloads clangd's macOS release into `packages/loxel/build/` so it can ship alongside
 * `loxel-server`: `clangd`, thinned to this machine's architecture and stripped, and
 * `clangd-resource`, the release's `lib/clang/<major>` without its sanitizer runtimes, which only
 * matter for linking. Its `include` holds the compiler headers, and its `share` the sanitizer
 * ignorelists, whose absence is an error on a project built with `-fsanitize=cfi`. The manager
 * passes that directory as `--resource-dir`, whose layout has no version in it, so an upgrade
 * changes no path: only the manifest's version and pin (and license, if it changed).
 *
 * `language-servers/clangd.json` pins the release's `clangd-mac-<version>.zip` (see
 * pinned-download.ts).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { $ } from "bun";

import { BUILD_DIR, downloadReleaseBinary } from "./download-release-binary";
import { manifestFile, manifestVersion } from "./language-server-manifest";

const VERSION = await manifestVersion("clangd");
/** The major version, the name of clangd's resource directory (`lib/clang/<major>`). */
const MAJOR = VERSION.slice(0, VERSION.indexOf("."));
/** The release's `clangd-mac-<version>.zip`, a universal binary. */
const ARCHIVE = await manifestFile("clangd", "mac");

const outBinary = path.join(BUILD_DIR, "clangd");
const outResourceDir = path.join(BUILD_DIR, "clangd-resource");
const release = path.join(BUILD_DIR, "clangd-release");
/** Written last, so it marks a finished build of this version and not an interrupted or older one. */
const stamp = path.join(BUILD_DIR, "clangd.version");

if (existsSync(stamp) && readFileSync(stamp, "utf8") === VERSION) {
  console.log(`clangd ${VERSION} already present at ${outBinary}, skipping download`);
  process.exit(0);
}

for (const stale of [stamp, outBinary, outResourceDir, release]) {
  rmSync(stale, { recursive: true, force: true });
}

await downloadReleaseBinary({
  name: "clangd",
  url: ARCHIVE.url,
  sha256: ARCHIVE.sha256,
  member: `clangd_${VERSION}`,
  outBinary: release,
});

try {
  mkdirSync(outResourceDir);
  for (const dir of ["include", "share"]) {
    renameSync(path.join(release, "lib", "clang", MAJOR, dir), path.join(outResourceDir, dir));
  }

  const arch = process.arch === "arm64" ? "arm64" : "x86_64";
  await $`lipo ${path.join(release, "bin", "clangd")} -thin ${arch} -output ${outBinary}`;
  await $`strip -x ${outBinary}`;
  // Both steps invalidate the release's ad-hoc signature, and arm64 macOS runs nothing unsigned.
  await $`codesign -s - -f -i clangd ${outBinary}`;
  writeFileSync(stamp, VERSION);
} finally {
  rmSync(release, { recursive: true, force: true });
}
console.log(`Installed: ${outBinary} and ${outResourceDir}`);
