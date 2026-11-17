/**
 * Downloads the platform-specific LemMinX (Eclipse XML Language Server) native
 * binary from vscode-xml GitHub releases into `packages/loxel/build/lemminx/`
 * so it can ship alongside `loxel-server` via electron-builder extraResources.
 *
 * LemMinX is compiled to a native binary via GraalVM — no JRE required at
 * runtime. The zip for each platform is pinned by SHA256 in `language-servers/lemminx.json`, which
 * Renovate bumps (renovate.json).
 */

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";

import { installedFrom, recordInstalledFrom } from "./download-release-binary";
import { manifestSha256, manifestVersion } from "./language-server-manifest";

const VERSION = await manifestVersion("lemminx");
const LOXEL = path.resolve(import.meta.dir, "..");
const OUTDIR = path.join(LOXEL, "build", "lemminx");

function platformKey(): string {
  const arch = process.arch === "arm64" ? "aarch_64" : "x86_64";
  if (process.platform === "win32") return "win32";
  const os = process.platform === "darwin" ? "osx" : process.platform === "linux" ? "linux" : "";
  if (!os) return "";
  return `${os}-${arch}`;
}

const key = platformKey();
if (!key) throw new Error(`LemMinX has no build for ${process.platform}`);
const expectedHash = await manifestSha256("lemminx", key);

const isWindows = process.platform === "win32";
const binaryName = isWindows ? `lemminx-${key}.exe` : `lemminx-${key}`;
const outBinary = path.join(OUTDIR, isWindows ? "lemminx.exe" : "lemminx");

if (installedFrom(outBinary, expectedHash)) {
  console.log(`lemminx already present at ${outBinary}, skipping download`);
  process.exit(0);
}

const zipName = `lemminx-${key}.zip`;
const url = `https://github.com/redhat-developer/vscode-xml/releases/download/${VERSION}/${zipName}`;

rmSync(OUTDIR, { recursive: true, force: true });
mkdirSync(OUTDIR, { recursive: true });

console.log(`Downloading ${url}`);
const res = await fetch(url);
if (!res.ok) {
  console.error(`Download failed: ${res.status} ${res.statusText}`);
  process.exit(1);
}

const zipBytes = new Uint8Array(await res.arrayBuffer());
const actualHash = createHash("sha256").update(zipBytes).digest("hex");
if (actualHash !== expectedHash) {
  console.error(`SHA256 mismatch!\n  expected: ${expectedHash}\n  actual:   ${actualHash}`);
  process.exit(1);
}

const zipPath = path.join(OUTDIR, zipName);
await Bun.write(zipPath, zipBytes);

console.log("Extracting (SHA256 verified)...");
const unzip = Bun.spawn(["unzip", "-o", zipPath, binaryName, "-d", OUTDIR], {
  stdout: "inherit",
  stderr: "inherit",
});
const code = await unzip.exited;
if (code !== 0) {
  rmSync(zipPath, { force: true });
  console.error("unzip failed");
  process.exit(1);
}

const extractedPath = path.join(OUTDIR, binaryName);
if (!existsSync(extractedPath)) {
  rmSync(zipPath, { force: true });
  console.error(`Expected ${extractedPath} after unzip but it was not found`);
  process.exit(1);
}

if (extractedPath !== outBinary) {
  renameSync(extractedPath, outBinary);
}

chmodSync(outBinary, 0o755);
recordInstalledFrom(outBinary, expectedHash);
rmSync(zipPath);
console.log(`Installed: ${outBinary}`);
