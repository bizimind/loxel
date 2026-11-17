/**
 * Downloads the platform-specific LemMinX (Eclipse XML Language Server) native
 * binary from vscode-xml GitHub releases into `packages/loxel/build/lemminx/`
 * so it can ship alongside `loxel-server` via electron-builder extraResources.
 *
 * LemMinX is compiled to a native binary via GraalVM — no JRE required at
 * runtime. SHA256 digests are pinned per platform from the release assets.
 */

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";

import { installedFrom, recordInstalledFrom } from "./download-release-binary";

// A bump also updates the release named in language-servers/lemminx.json, which the server bundle's notices list.
const VERSION = "0.29.3";
const LOXEL = path.resolve(import.meta.dir, "..");
const OUTDIR = path.join(LOXEL, "build", "lemminx");

/** Pinned SHA256 digests of the zip archives from the v0.29.3 release. */
const SHA256: Record<string, string> = {
  "osx-aarch_64": "185db5630ce85be43ea0fab034e7841b1327c2793db05ab481e029cf493d86ce",
  "osx-x86_64": "9e56123194b5c1fdc7d87f1bd21c83cc996ba7be913def3a2836a13305bcd273",
  "linux-x86_64": "1acc44e24201c1d2f5ccb4e43e7426ed0df6909207a81ff199810e2808104d89",
  "linux-aarch_64": "0b88a49e83c2611282672f5123ce33abf1371c8e3c55cad6ee45ea00626ffa1b",
  win32: "7eaefaac68253b0ec8e0ad1f1c0f2d0755423d4e99e52497428b52f80df28eb7",
};

function platformKey(): string {
  const arch = process.arch === "arm64" ? "aarch_64" : "x86_64";
  if (process.platform === "win32") return "win32";
  const os = process.platform === "darwin" ? "osx" : process.platform === "linux" ? "linux" : "";
  if (!os) return "";
  return `${os}-${arch}`;
}

const key = platformKey();
const expectedHash = SHA256[key];
if (!expectedHash) {
  console.error(`No pinned SHA256 for platform ${key}`);
  process.exit(1);
}

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
