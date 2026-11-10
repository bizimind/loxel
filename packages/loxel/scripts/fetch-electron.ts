/**
 * Download Loxel's patched Electron for one architecture into `build/electron-dist/`, where
 * electron-builder takes it as `electronDist`:
 *
 *   bun scripts/fetch-electron.ts <arm64|x64>
 *
 * Needs R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and CLOUDFLARE_ACCOUNT_ID. Fails when the build
 * this checkout pins was never uploaded, so a release can't fall back to stock Electron.
 */

import { mkdirSync } from "node:fs";
import path from "node:path";

import {
  DIST_DIR,
  currentBuild,
  distZipName,
  objectKey,
  parseArch,
  r2Client,
  sha256File,
} from "./electron-dist";

const archArg = Bun.argv[2];
if (!archArg) throw new Error("Usage: bun scripts/fetch-electron.ts <arm64|x64>");
const arch = parseArch(archArg);

const { version, id } = currentBuild();
const zipName = distZipName(version, arch);
const client = r2Client();
const zip = client.file(objectKey(id, zipName));
const checksum = client.file(objectKey(id, `${zipName}.sha256`));

if (!(await zip.exists()) || !(await checksum.exists())) {
  throw new Error(
    `No patched Electron ${id} for darwin-${arch} in R2. Build and upload it on a Mac with ` +
      "`pnpm -C packages/loxel run build:electron` (see docs/PATCHED_ELECTRON.md).",
  );
}

mkdirSync(DIST_DIR, { recursive: true });
const destination = path.join(DIST_DIR, zipName);
await Bun.write(destination, zip);

const expected = (await checksum.text()).trim();
const actual = await sha256File(destination);
if (actual !== expected) {
  throw new Error(`Checksum mismatch for ${zipName}: expected ${expected}, got ${actual}`);
}
console.log(`[fetch-electron] ${zipName} (${id}) -> ${destination}`);
