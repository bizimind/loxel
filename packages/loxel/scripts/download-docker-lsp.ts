/**
 * Downloads Docker's official `docker-language-server` binary from GitHub
 * releases into `packages/loxel/build/docker-language-server` so it can ship
 * alongside `loxel-server` via electron-builder extraResources.
 *
 * SHA256 digests are pinned per platform from the GitHub release API. The
 * binary is verified after download — a mismatch aborts the build.
 */

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const VERSION = "0.20.1";
const LOXEL = path.resolve(import.meta.dir, "..");
const OUTDIR = path.join(LOXEL, "build");

/** Pinned SHA256 digests from the v0.20.1 GitHub release. */
const SHA256: Record<string, string> = {
  "darwin-amd64": "2dbaec15645e940d1e02092f5b5e10148531a6206225e71faab7bfe71130b457",
  "darwin-arm64": "5a9d48fd2b1334d7d20a62faf542e611cca32dc79a478553ad65c27437467fac",
  "linux-amd64": "01907aa5b0eae11e44cffea0a993d08aa155542a9af570295dd1dff39e67692a",
  "linux-arm64": "bd56c7815e0a22cfb708669f3d5e817de91d9b54039ff7e52867142a132ad8d7",
  "windows-amd64": "3c1e5019cbd9779341d39c94589d058434ef295b3a1a0c0e89bdfb7ae4d59e2e",
  "windows-arm64": "ac1c1190deb7b605829a11702222eb5fe8a68968c287c8af34615f4f92c0712d",
};

function platformKey(): string {
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "amd64" : process.arch;
  const os =
    process.platform === "darwin"
      ? "darwin"
      : process.platform === "linux"
        ? "linux"
        : process.platform === "win32"
          ? "windows"
          : process.platform;
  return `${os}-${arch}`;
}

const key = platformKey();
const expectedHash = SHA256[key];
if (!expectedHash) {
  console.error(`No pinned SHA256 for platform ${key}`);
  process.exit(1);
}

const ext = process.platform === "win32" ? ".exe" : "";
const assetName = `docker-language-server-${key}-v${VERSION}${ext}`;
const url = `https://github.com/docker/docker-language-server/releases/download/v${VERSION}/${assetName}`;
const outBinary = path.join(OUTDIR, `docker-language-server${ext}`);

if (existsSync(outBinary)) {
  console.log(`docker-language-server already present at ${outBinary}, skipping download`);
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

await Bun.write(outBinary, bytes);
chmodSync(outBinary, 0o755);
console.log(`Installed: ${outBinary} (SHA256 verified)`);
