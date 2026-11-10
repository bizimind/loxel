/**
 * Loxel ships a patched Electron: the release that package.json pins exactly, with the patches in
 * `electron/patches/` applied in order. `build-electron.ts` builds it on a Mac and uploads the
 * zips to R2, and the release workflow fetches them with `fetch-electron.ts`. This module is the
 * one place that names a build, so both sides always agree on which binary goes with which source.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { S3Client } from "bun";

export const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");
export const PATCHES_DIR = path.join(PACKAGE_ROOT, "electron", "patches");
/** Where the fetched zips land; electron-builder reads it as `electronDist`. */
export const DIST_DIR = path.join(PACKAGE_ROOT, "build", "electron-dist");

export const ELECTRON_ARCHES = ["arm64", "x64"] as const;
export type ElectronArch = (typeof ELECTRON_ARCHES)[number];

export function parseArch(value: string): ElectronArch {
  const arch = ELECTRON_ARCHES.find((candidate) => candidate === value);
  if (!arch)
    throw new Error(`Unknown architecture "${value}"; expected ${ELECTRON_ARCHES.join(" or ")}`);
  return arch;
}

/** The exact Electron version package.json pins. A range is refused: the build must match it. */
export function electronVersion(packageJson: unknown): string {
  const devDependencies =
    typeof packageJson === "object" && packageJson !== null && "devDependencies" in packageJson
      ? packageJson.devDependencies
      : undefined;
  const version =
    typeof devDependencies === "object" && devDependencies !== null && "electron" in devDependencies
      ? devDependencies.electron
      : undefined;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(
      `package.json must pin an exact Electron release (e.g. "45.3.0"), not ${JSON.stringify(version)}`,
    );
  }
  return version;
}

export interface Patch {
  name: string;
  contents: Uint8Array;
}

/** The patches in application order (their numeric file-name prefix). */
export function readPatches(dir = PATCHES_DIR): Patch[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".patch"))
    .sort()
    .map((name) => ({ name, contents: readFileSync(path.join(dir, name)) }));
}

/**
 * Names a build by its Electron version and a digest of its patches (names and contents, in order),
 * so a changed or reordered patch can never be paired with a binary built from the old ones.
 */
export function buildId(version: string, patches: readonly Patch[]): string {
  const hash = createHash("sha256");
  for (const patch of patches) {
    hash.update(patch.name).update("\0").update(patch.contents).update("\0");
  }
  return `${version}-${hash.digest("hex").slice(0, 16)}`;
}

/** The file name electron-builder looks for inside an `electronDist` directory. */
export function distZipName(version: string, arch: ElectronArch): string {
  return `electron-v${version}-darwin-${arch}.zip`;
}

/** Object key in the R2 bucket for a file of a build. */
export function objectKey(id: string, file: string): string {
  return `loxel/electron/${id}/${file}`;
}

export interface CurrentBuild {
  version: string;
  id: string;
  patches: Patch[];
}

/** The build this checkout needs: package.json's Electron with its patches. */
export function currentBuild(): CurrentBuild {
  const packageJson: unknown = JSON.parse(
    readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"),
  );
  const version = electronVersion(packageJson);
  const patches = readPatches();
  return { version, id: buildId(version, patches), patches };
}

/** The R2 bucket the release artifacts live in, from the same credentials the release uses. */
export function r2Client(env: Record<string, string | undefined> = process.env): S3Client {
  const names = ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "CLOUDFLARE_ACCOUNT_ID"] as const;
  const missing = names.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(
      `Set ${missing.join(", ")} to reach R2 (an R2 API token for the "loxel" bucket)`,
    );
  }
  return new S3Client({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    endpoint: `https://${env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    bucket: "loxel",
  });
}

/** Hex SHA-256 of a file, streamed so a large zip isn't read into memory at once. */
export async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of Bun.file(file).stream()) hash.update(chunk);
  return hash.digest("hex");
}
