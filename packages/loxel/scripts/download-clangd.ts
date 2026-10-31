/**
 * Downloads clangd's macOS release into `packages/loxel/build/` so it can ship alongside
 * `loxel-server`: `clangd`, thinned to this machine's architecture and stripped, and
 * `clangd-resource`, the release's `lib/clang/<major>` without its sanitizer runtimes, which only
 * matter for linking. Its `include` holds the compiler headers, and its `share` the sanitizer
 * ignorelists, whose absence is an error on a project built with `-fsanitize=cfi`. The manager
 * passes that directory as `--resource-dir`, whose layout has no version in it, so an upgrade
 * changes no path: only VERSION and SHA256 here, and the source URL and license in the manifest.
 *
 * clangd publishes no checksum files, so the digest is pinned from the release asset.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { $ } from "bun";

import { BUILD_DIR, downloadReleaseBinary } from "./download-release-binary";

const VERSION = "23.1.0";
const MAJOR = VERSION.split(".")[0];

/** Pinned SHA256 digest of `clangd-mac-23.1.0.zip`, a universal binary. */
const SHA256 = "1082e6638223b785ca2daf0939f13afcd0bb95c84ee9a4bbaff4745365159253";

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
  url: `https://github.com/clangd/clangd/releases/download/${VERSION}/clangd-mac-${VERSION}.zip`,
  sha256: SHA256,
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
