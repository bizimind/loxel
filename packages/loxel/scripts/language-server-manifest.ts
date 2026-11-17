/**
 * The manifests in scripts/language-servers/, one per bundled language server:
 *
 *   { "script": "download-x.ts", "resources": ["x"], "platforms"?: ["darwin"], ... }
 *
 * `script` (in scripts/) writes `resources` (paths under build/), and `platforms` limits a
 * manifest to those platforms. Each manifest also says what it ships, for the SBOM: one built from
 * npm packages names them in `npm` (they must be `dependencies` of loxel, so the lockfile's SBOM
 * lists them); any other carries `version`, `purl` and `license` (an SPDX expression). `version`
 * is the one place the version lives: the script reads it with `manifestVersion`, and `{version}`
 * in `purl` and `source` stands for it. `source`, `licenseFile` and `note` are for its notice.
 *
 * A script that downloads its server pins the file in `download` and `sha256` (see
 * pinned-download.ts) and reads it with `manifestFile`.
 */

import { readdirSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import { pinnedFile, readPinnedDownload } from "./pinned-download";

export const MANIFEST_DIR = path.join(import.meta.dir, "language-servers");

const VERSION_PLACEHOLDER = "{version}";

const BaseSchema = z.strictObject({
  script: z.string(),
  resources: z.array(z.string()),
  platforms: z.array(z.string()).optional(),
  npm: z.array(z.string()).optional(),
  source: z.string().optional(),
  licenseFile: z.string().optional(),
  note: z.string().optional(),
});

const ManifestSchema = z.union([
  BaseSchema.extend({
    version: z.string().min(1),
    // `pkg:<type>/<namespace>/<name>@<version>`, its version holding `{version}` (`v{version}`).
    purl: z.string().regex(/^pkg:[^@]+@[^@]*\{version\}/),
    license: z.string().min(1),
    // A pinned download (pinned-download.ts), which readPinnedDownload checks.
    download: z.string().optional(),
    sha256: z.record(z.string(), z.string()).optional(),
  }),
  BaseSchema.extend({ npm: z.array(z.string()).nonempty() }),
]);

export type Manifest = z.infer<typeof ManifestSchema> & { name: string };

/** What a manifest that is not built from npm packages ships, with `{version}` filled in. */
export interface ShippedComponent {
  name: string;
  version: string;
  purl: string;
  license: string;
  source?: string;
}

/** Parses the manifest `<name>.json`, read from `file`. Throws when it is invalid. */
export function parseManifest(name: string, file: string, json: unknown): Manifest {
  const parsed = ManifestSchema.safeParse(json);
  if (!parsed.success) {
    const hint = 'it needs "npm", or "version", "purl" and "license"';
    throw new Error(`${file}: ${hint}\n${z.prettifyError(parsed.error)}`);
  }
  const manifest = { ...parsed.data, name };
  if ("version" in manifest && (manifest.download || manifest.sha256)) {
    readPinnedDownload(file, json);
  }
  return manifest;
}

/** The manifest `scripts/language-servers/<name>.json`. Throws when it is missing or invalid. */
export async function readManifest(name: string): Promise<Manifest> {
  const file = path.join(MANIFEST_DIR, `${name}.json`);
  return parseManifest(name, file, await Bun.file(file).json());
}

/** Every manifest, in name order so builds are the same everywhere. */
export async function readAllManifests(): Promise<Manifest[]> {
  const names = readdirSync(MANIFEST_DIR)
    .filter((file) => file.endsWith(".json"))
    .map((file) => path.basename(file, ".json"))
    .toSorted();
  return Promise.all(names.map(readManifest));
}

/** The manifests that build on `platform`. */
export async function readManifests(platform: string = process.platform): Promise<Manifest[]> {
  const manifests = await readAllManifests();
  return manifests.filter((m) => !m.platforms || m.platforms.includes(platform));
}

/** The version a download or build script installs, from its manifest. */
export async function manifestVersion(name: string): Promise<string> {
  const manifest = await readManifest(name);
  if (!("version" in manifest)) throw new Error(`${name}.json has no version`);
  return manifest.version;
}

/** The URL and pinned SHA256 of the file the manifest's script downloads for `target`. */
export async function manifestFile(
  name: string,
  target: string,
): Promise<{ url: string; sha256: string }> {
  const file = path.join(MANIFEST_DIR, `${name}.json`);
  return pinnedFile(name, readPinnedDownload(file, await Bun.file(file).json()), target);
}

/** The targets the manifest pins a file for, such as the one archive of a single download. */
export async function manifestTargets(name: string): Promise<string[]> {
  const file = path.join(MANIFEST_DIR, `${name}.json`);
  return Object.keys(readPinnedDownload(file, await Bun.file(file).json()).sha256);
}

/** `template` with the manifest's version in place of `{version}`. */
function expandVersion(manifest: Extract<Manifest, { version: string }>, template: string): string {
  return template.replaceAll(VERSION_PLACEHOLDER, manifest.version);
}

/** The component a manifest ships, or undefined when it is built only from npm packages. */
export function shippedComponent(manifest: Manifest): ShippedComponent | undefined {
  if (!("version" in manifest)) return undefined;
  // The purl's name, `pkg:<type>/<namespace>/<name>@<version>`: what the version is a version of.
  const unversioned = manifest.purl.slice(0, manifest.purl.indexOf("@"));
  return {
    name: unversioned.slice(unversioned.lastIndexOf("/") + 1),
    version: manifest.version,
    purl: expandVersion(manifest, manifest.purl),
    license: manifest.license,
    source: manifest.source === undefined ? undefined : expandVersion(manifest, manifest.source),
  };
}

/**
 * The version of `modulePath` that the pinned Go module in `moduleDir` requires, which is what the
 * build compiles. Throws unless it is the manifest's version, which the SBOM names.
 */
export async function pinnedGoModuleVersion(
  name: string,
  moduleDir: string,
  modulePath: string,
): Promise<string> {
  const goMod = await Bun.file(path.join(moduleDir, "go.mod")).text();
  // A lone `require` line, or a line in a `require ( ... )` block (`// indirect` there when only a
  // `tool` directive names the module).
  const pattern = new RegExp(
    `^(?:require)?[ \\t]+${modulePath.replaceAll(".", "\\.")} (\\S+)`,
    "m",
  );
  const required = pattern.exec(goMod)?.[1];
  const file = `${path.basename(moduleDir)}/go.mod`;
  if (!required) throw new Error(`${file} does not require ${modulePath}`);
  const version = await manifestVersion(name);
  if (required !== `v${version}`) {
    throw new Error(`${file} requires ${modulePath} ${required}, but ${name}.json says ${version}`);
  }
  return required;
}
