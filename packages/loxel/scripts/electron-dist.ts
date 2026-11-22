/**
 * Loxel ships a patched Electron: the release that package.json pins exactly, with the patches in
 * `electron/patches/` applied in order. `build-electron.ts` builds it on a Mac and uploads the
 * zips to R2, and the release workflow fetches them with `fetch-electron.ts`. This module is the
 * one place that names a build, so both sides always agree on which binary goes with which source.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { S3Client } from "bun";

import { SHA256_HEX, isRecord } from "./pinned-download";

export const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");
export const PATCHES_DIR = path.join(PACKAGE_ROOT, "electron", "patches");
/** The private CI bucket the builds are stored in. */
export const BUCKET = "loxel-ci-private";
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

/** `<nnnn>-<name>.patch`: the zero-padded number sets the order the patches apply in. */
const PATCH_NAME = /^\d{4}-[a-z0-9]+(?:-[a-z0-9]+)*\.patch$/;

/** The doc each patch has beside it: `0001-name.patch` is described in `0001-name-patch.md`. */
export function patchDocName(patchName: string): string {
  return patchName.replace(/\.patch$/, "-patch.md");
}

/**
 * The patches in application order (their numeric file-name prefix). Only `.patch` files are
 * patches, so editing a patch's doc changes no build.
 */
export function readPatches(dir = PATCHES_DIR): Patch[] {
  const names = readdirSync(dir).filter((name) => name.endsWith(".patch"));
  const misnamed = names.filter((name) => !PATCH_NAME.test(name));
  if (misnamed.length > 0) {
    throw new Error(`Name each patch <nnnn>-<name>.patch, not ${misnamed.join(", ")}`);
  }
  const sorted = names.toSorted();
  const shared = sorted.filter((name, i) =>
    sorted.some((other, j) => j !== i && other.slice(0, 4) === name.slice(0, 4)),
  );
  if (shared.length > 0) {
    throw new Error(`Each patch needs its own number: ${shared.join(", ")}`);
  }
  return sorted.map((name) => ({ name, contents: readFileSync(path.join(dir, name)) }));
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

/**
 * Next to a zip in DIST_DIR, the ID of the build it came from, so a zip left from before a patch
 * change is never packaged as the current build.
 */
export function buildIdMarker(zipPath: string): string {
  return `${zipPath}.build-id`;
}

/** Object key in the private CI bucket for a file of a build. */
export function objectKey(id: string, file: string): string {
  return `electron/${id}/${file}`;
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

/**
 * The private CI bucket the builds live in. They are an input to the release, not something users
 * download, so they stay out of the public release bucket.
 */
export function r2Client(env: Record<string, string | undefined> = process.env): S3Client {
  const names = [
    "R2_PRIVATE_ACCESS_KEY_ID",
    "R2_PRIVATE_SECRET_ACCESS_KEY",
    "CLOUDFLARE_ACCOUNT_ID",
  ] as const;
  const missing = names.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(
      `Set ${missing.join(", ")} to reach R2 (an R2 API token for the "${BUCKET}" bucket)`,
    );
  }
  return new S3Client({
    accessKeyId: env.R2_PRIVATE_ACCESS_KEY_ID,
    secretAccessKey: env.R2_PRIVATE_SECRET_ACCESS_KEY,
    endpoint: `https://${env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    bucket: BUCKET,
  });
}

/**
 * The SHA-256 of each architecture's zip for one build, committed so that the release trusts the
 * repository, not the bucket: a different binary needs a reviewed change to this file.
 * `build-electron.ts` writes it, and it is committed with the version or patch change it builds.
 */
export const BUILDS_FILE = path.join(PACKAGE_ROOT, "electron", "builds.json");

function readPins(file: string): { id: unknown; sha256: Record<string, unknown> } | undefined {
  if (!existsSync(file)) return undefined;
  const pins: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!isRecord(pins) || !isRecord(pins.sha256)) throw new Error(`${file} is malformed`);
  return { id: pins.id, sha256: pins.sha256 };
}

/** The committed SHA-256 of build `id`'s zip for `arch`; fails when the file pins none. */
export function pinnedSha256(id: string, arch: ElectronArch, file = BUILDS_FILE): string {
  const pins = readPins(file);
  const sha256 = pins?.id === id ? pins.sha256[arch] : undefined;
  if (typeof sha256 !== "string" || !SHA256_HEX.test(sha256)) {
    throw new Error(
      `${path.relative(PACKAGE_ROOT, file)} pins no SHA-256 for patched Electron ${id} darwin-${arch}. ` +
        "Build it with `pnpm -C packages/loxel run build:electron` and commit the file it updates.",
    );
  }
  return sha256;
}

/** Record build `id`'s zip SHA-256 for `arch`, dropping the pins of any other build. */
export function pinSha256(id: string, arch: ElectronArch, sha256: string, file = BUILDS_FILE) {
  const pins = readPins(file);
  const kept = pins?.id === id ? pins.sha256 : {};
  writeFileSync(file, `${JSON.stringify({ id, sha256: { ...kept, [arch]: sha256 } }, null, 2)}\n`);
}

/** Hex SHA-256 of a file, streamed so a large zip isn't read into memory at once. */
export async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of Bun.file(file).stream()) hash.update(chunk);
  return hash.digest("hex");
}

/**
 * Whether a build's zip for `arch` is fully in R2. Its checksum is uploaded after the zip, so a
 * zip without one is an interrupted upload, not a build. The checksum only marks the upload as
 * complete: the release checks the zip against BUILDS_FILE.
 */
export async function isUploaded(
  client: S3Client,
  id: string,
  version: string,
  arch: ElectronArch,
): Promise<boolean> {
  const zipName = distZipName(version, arch);
  return (
    (await client.file(objectKey(id, `${zipName}.sha256`)).exists()) &&
    (await client.file(objectKey(id, zipName)).exists())
  );
}
