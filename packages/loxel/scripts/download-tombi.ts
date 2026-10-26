/**
 * Downloads the Tombi CLI (TOML formatter, linter and language server) from
 * GitHub releases into `packages/loxel/build/tombi` so it can ship alongside
 * `loxel-server` via electron-builder extraResources. Loxel runs it as
 * `tombi lsp`.
 *
 * SHA256 digests are pinned per platform from the release assets. The archive
 * is verified in memory before anything is extracted, and only the binary is
 * extracted from it.
 */

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import path from "node:path";

const VERSION = "1.9.6";
const LOXEL = path.resolve(import.meta.dir, "..");
const OUTDIR = path.join(LOXEL, "build");

/** Pinned SHA256 digests of the archives from the v1.9.6 release, by Rust target. */
const SHA256: Record<string, string> = {
  "aarch64-apple-darwin": "e3e29db219a07e2e8534735a61c340f1bb3ec1bee845a4fcd6d72f59e0e9383e",
  "x86_64-apple-darwin": "8f9b2e3ba04f2d2773b15211024233a89d6ba0e1732c6b9d0b5f98a06ab2bd75",
  "aarch64-unknown-linux-musl": "e29f2af283d9c090c7da16468406ffa5b7183d06cefeae19da40ac6d70ffc42c",
  "x86_64-unknown-linux-musl": "a845f9275c83ee8ce408cc16fee11a7dbe5009214a4b92f2bbac5c0aa3afafe3",
  "aarch64-pc-windows-msvc": "c86f4926776c251f9d82946c470f6c33d61a597d055bf1861d3630a38cab9f59",
  "x86_64-pc-windows-msvc": "6080696714182be2e35bd89e3bbe4f301f92fb2cb888088fd282c341a4f1e5c1",
};

function rustTarget(): string {
  const arch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : "";
  const os =
    process.platform === "darwin"
      ? "apple-darwin"
      : process.platform === "linux"
        ? // Tombi publishes only static musl builds for Linux.
          "unknown-linux-musl"
        : process.platform === "win32"
          ? "pc-windows-msvc"
          : "";
  return `${arch}-${os}`;
}

const target = rustTarget();
const expectedHash = SHA256[target];
if (!expectedHash) {
  console.error(`No pinned SHA256 for target ${target}`);
  process.exit(1);
}

const isWindows = process.platform === "win32";
const outBinary = path.join(OUTDIR, isWindows ? "tombi.exe" : "tombi");
// Windows releases are a zip with `tombi.exe` at the root; the others a tarball with
// `tombi-cli-<version>-<target>/tombi`.
const archiveBase = `tombi-cli-${VERSION}-${target}`;
const archiveName = isWindows ? `${archiveBase}.zip` : `${archiveBase}.tar.gz`;
const member = isWindows ? "tombi.exe" : `${archiveBase}/tombi`;
const url = `https://github.com/tombi-toml/tombi/releases/download/v${VERSION}/${archiveName}`;

if (existsSync(outBinary)) {
  console.log(`tombi already present at ${outBinary}, skipping download`);
  process.exit(0);
}

mkdirSync(OUTDIR, { recursive: true });

console.log(`Downloading ${url}`);
const res = await fetch(url);
if (!res.ok) {
  console.error(`Download failed: ${res.status} ${res.statusText}`);
  process.exit(1);
}

const bytes = new Uint8Array(await res.arrayBuffer());
const actualHash = createHash("sha256").update(bytes).digest("hex");
if (actualHash !== expectedHash) {
  console.error(`SHA256 mismatch!\n  expected: ${expectedHash}\n  actual:   ${actualHash}`);
  process.exit(1);
}

// Extract in a scratch directory of its own, so nothing but the binary reaches `build/`.
const scratch = mkdtempSync(path.join(OUTDIR, "tombi-download-"));
const fail = (message: string): never => {
  rmSync(scratch, { recursive: true, force: true });
  console.error(message);
  process.exit(1);
};
const archivePath = path.join(scratch, archiveName);
await Bun.write(archivePath, bytes);
console.log("Extracting (SHA256 verified)...");
// bsdtar (macOS, Windows) reads zips too; GNU tar on Linux only gets tarballs.
const tar = Bun.spawn(["tar", "-xf", archivePath, "-C", scratch, member], {
  stdout: "inherit",
  stderr: "inherit",
});
if ((await tar.exited) !== 0) fail("tar failed");
const extracted = path.join(scratch, member);
if (!existsSync(extracted)) fail(`Expected ${extracted} after extraction but it was not found`);
renameSync(extracted, outBinary);
chmodSync(outBinary, 0o755);
rmSync(scratch, { recursive: true, force: true });
console.log(`Installed: ${outBinary}`);
