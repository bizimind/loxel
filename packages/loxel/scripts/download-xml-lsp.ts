/**
 * Downloads the platform-specific LemMinX (Eclipse XML Language Server) native
 * binary from vscode-xml GitHub releases into `packages/loxel/build/lemminx/`
 * so it can ship alongside `loxel-server` via electron-builder extraResources.
 *
 * LemMinX is compiled to a native binary via GraalVM — no JRE required at
 * runtime. SHA256 digests are pinned per platform from the release assets.
 */

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

const VERSION = "0.29.2";
const LOXEL = path.resolve(import.meta.dir, "..");
const OUTDIR = path.join(LOXEL, "build", "lemminx");

/** Pinned SHA256 digests of the zip archives from the v0.29.2 release. */
const SHA256: Record<string, string> = {
  "osx-aarch_64": "346be4069662adda81d17f184bea148d6dda25057fc809178b3a888327e8cda8",
  "osx-x86_64": "45a5789fc9ec5b293db541b94f14966d3355cc4e146d1bbc40feb482c1e85cd0",
  "linux-x86_64": "fb98f6fbf254068ec49d36a1f8c5163121011dd7d27f09dd7acfa5546fb58b63",
  "linux-aarch_64": "6937912614d6950497d1f8ffada56b03237e7b6f30e384102f485b3d0b359d74",
  win32: "3acc10086d0b231ac16345122c1299c409cd635dc1bada54351dddec3e122724",
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

if (existsSync(outBinary)) {
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
  console.error("unzip failed");
  process.exit(1);
}

const extractedPath = path.join(OUTDIR, binaryName);
if (!existsSync(extractedPath)) {
  console.error(`Expected ${extractedPath} after unzip but it was not found`);
  process.exit(1);
}

if (extractedPath !== outBinary) {
  const { rename } = await import("node:fs/promises");
  await rename(extractedPath, outBinary);
}

chmodSync(outBinary, 0o755);
rmSync(zipPath);
console.log(`Installed: ${outBinary}`);
