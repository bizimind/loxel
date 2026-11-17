/**
 * Downloads the platform-specific `terraform-ls` binary from HashiCorp
 * releases into `packages/loxel/build/terraform-ls` so it can ship alongside
 * `loxel-server` via electron-builder extraResources.
 *
 * SHA256 digests are pinned from HashiCorp's published SHA256SUMS file.
 * The zip is verified after download and before extraction.
 */

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";

import { installedFrom, recordInstalledFrom } from "./download-release-binary";

const VERSION = "0.39.1";
const LOXEL = path.resolve(import.meta.dir, "..");
const OUTDIR = path.join(LOXEL, "build");

/** Pinned SHA256 digests from the v0.39.1 HashiCorp SHA256SUMS. */
const SHA256: Record<string, string> = {
  darwin_amd64: "25814afdbec9163de4ad8db58960195b9fc65ddc5405a5df7163bbdbd08b5325",
  darwin_arm64: "07748aa989fc3b9f6e4538ff83bc2e607ebc20c7587ce6556ae555d631e70b1b",
  linux_amd64: "fe2a158e4a1a8ec8047dae9e06c439b468412aa579929ba28b2e1258cedef9c0",
  linux_arm64: "a72a6d9f72580cfc30cc06d3c973fd5f55790f62e3ddb195998435070d9af36d",
  windows_amd64: "bb8523b2e109c2ad719dbf6245c4be035386e322cb44e8f01c74b1caa4680efb",
  windows_arm64: "0b6fe711414f29eeaaa09509fcb073e1f3269705e2de87a8b8ce7e77bc43fb6c",
};

function platformSlug(): string {
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "amd64" : process.arch;
  const os =
    process.platform === "darwin"
      ? "darwin"
      : process.platform === "linux"
        ? "linux"
        : process.platform === "win32"
          ? "windows"
          : process.platform;
  return `${os}_${arch}`;
}

const slug = platformSlug();
const expectedHash = SHA256[slug];
if (!expectedHash) {
  console.error(`No pinned SHA256 for platform ${slug}`);
  process.exit(1);
}

const url = `https://releases.hashicorp.com/terraform-ls/${VERSION}/terraform-ls_${VERSION}_${slug}.zip`;
const binaryName = process.platform === "win32" ? "terraform-ls.exe" : "terraform-ls";
const outBinary = path.join(OUTDIR, binaryName);

if (installedFrom(outBinary, expectedHash)) {
  console.log(`terraform-ls already present at ${outBinary}, skipping download`);
  process.exit(0);
}

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

const tmpDir = path.join(OUTDIR, ".terraform-ls-tmp");
rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(tmpDir, { recursive: true });

const zipPath = path.join(tmpDir, "terraform-ls.zip");
await Bun.write(zipPath, zipBytes);

console.log("Extracting (SHA256 verified)...");
const unzip = Bun.spawn(["unzip", "-o", zipPath, binaryName, "-d", tmpDir], {
  stdout: "inherit",
  stderr: "inherit",
});
const code = await unzip.exited;
if (code !== 0) {
  rmSync(tmpDir, { recursive: true, force: true });
  console.error("unzip failed");
  process.exit(1);
}

const extracted = path.join(tmpDir, binaryName);
if (!existsSync(extracted)) {
  rmSync(tmpDir, { recursive: true, force: true });
  console.error(`Expected ${extracted} after unzip but it was not found`);
  process.exit(1);
}

renameSync(extracted, outBinary);
chmodSync(outBinary, 0o755);
recordInstalledFrom(outBinary, expectedHash);
rmSync(tmpDir, { recursive: true, force: true });
console.log(`Installed: ${outBinary}`);
