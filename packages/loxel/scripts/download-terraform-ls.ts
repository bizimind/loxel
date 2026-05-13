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

const VERSION = "0.36.3";
const LOXEL = path.resolve(import.meta.dir, "..");
const OUTDIR = path.join(LOXEL, "build");

/** Pinned SHA256 digests from the v0.36.3 HashiCorp SHA256SUMS. */
const SHA256: Record<string, string> = {
  darwin_amd64: "3dfd12536e0c5ec5eb25362e3c092666effafc4c61f5630406ccf8f7715a0eb5",
  darwin_arm64: "542ae3b59dc15d7404fd0d732480485ec3c68b258bb74e4e95d1239afca8b426",
  linux_amd64: "3cc5498dc37668ca005d957e85c8be9e5b2100fcfecb7f3d9b70cd8d69a5f654",
  linux_arm64: "bbf70fc9ea4bf19c23b56286d98d029a303a6648cf5009762e68b90c5ab9114d",
  windows_amd64: "0592ee4237975bf8453462944f65be05fb20a5cf4d50c707811a0dd841b58d34",
  windows_arm64: "6dfde7b4abfe8c244ebaf8acae4e9c4bd5a5314a73c73f129a26653f18fdd0d9",
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

if (existsSync(outBinary)) {
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
rmSync(tmpDir, { recursive: true, force: true });
console.log(`Installed: ${outBinary}`);
