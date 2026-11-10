/**
 * Download Loxel's patched Electron for one architecture into `build/electron-dist/`, where
 * electron-builder takes it as `electronDist`, or check that it is in R2 for every architecture:
 *
 *   bun scripts/fetch-electron.ts <arm64|x64>
 *   bun scripts/fetch-electron.ts --check
 *
 * Needs R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and CLOUDFLARE_ACCOUNT_ID. Fails when the build
 * this checkout pins was never uploaded, so a release can't fall back to stock Electron. The
 * release workflow runs `--check` before it bumps the version, so a missing build stops it before
 * it leaves a release commit or tag behind.
 */

import { mkdirSync } from "node:fs";
import path from "node:path";

import {
  DIST_DIR,
  ELECTRON_ARCHES,
  buildIdMarker,
  currentBuild,
  distZipName,
  isUploaded,
  objectKey,
  parseArch,
  r2Client,
  sha256File,
} from "./electron-dist";

const arg = Bun.argv[2];
if (!arg) throw new Error("Usage: bun scripts/fetch-electron.ts <arm64|x64> | --check");

const { version, id } = currentBuild();
const client = r2Client();
const howToUpload =
  "Build and upload it on a Mac with `pnpm -C packages/loxel run build:electron` " +
  "(see packages/loxel/docs/PATCHED_ELECTRON.md).";

if (arg === "--check") {
  const missing = [];
  for (const arch of ELECTRON_ARCHES) {
    if (!(await isUploaded(client, id, version, arch))) missing.push(`darwin-${arch}`);
  }
  if (missing.length > 0) {
    throw new Error(
      `Patched Electron ${id} is not in R2 for ${missing.join(", ")}. ${howToUpload}`,
    );
  }
  console.log(`[fetch-electron] patched Electron ${id} is in R2 for every architecture`);
  process.exit(0);
}

const arch = parseArch(arg);
if (!(await isUploaded(client, id, version, arch))) {
  throw new Error(`No patched Electron ${id} for darwin-${arch} in R2. ${howToUpload}`);
}

const zipName = distZipName(version, arch);
mkdirSync(DIST_DIR, { recursive: true });
const destination = path.join(DIST_DIR, zipName);
await Bun.write(destination, client.file(objectKey(id, zipName)));

const expected = (await client.file(objectKey(id, `${zipName}.sha256`)).text()).trim();
const actual = await sha256File(destination);
if (actual !== expected) {
  throw new Error(`Checksum mismatch for ${zipName}: expected ${expected}, got ${actual}`);
}
await Bun.write(buildIdMarker(destination), `${id}\n`);
console.log(`[fetch-electron] ${zipName} (${id}) -> ${destination}`);
