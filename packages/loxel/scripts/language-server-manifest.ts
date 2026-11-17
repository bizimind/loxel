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
 * A script that downloads GitHub release assets pins their digests in `sha256`, which it reads with
 * `manifestSha256`. Each is keyed `<release tag>/<target>`, the target being the script's own name
 * for the asset (a Rust target triple, say): the tag (the purl's version) is repeated in every key
 * because Renovate, which bumps these manifests (renovate.json), updates one version and one digest
 * per dependency, so each pinned asset needs its own copy of the version. Renovate replaces the
 * `version` field at the first occurrence of its text, so nothing before that field may contain it.
 */

import { readdirSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

export const MANIFEST_DIR = path.join(import.meta.dir, "language-servers");

const VERSION_PLACEHOLDER = "{version}";
const GITHUB_PURL_PREFIX = "pkg:github/";

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
    sha256: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)).optional(),
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
  if ("sha256" in manifest && manifest.sha256) checkPinKeys(file, manifest, manifest.sha256);
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

type VersionedManifest = Extract<Manifest, { version: string }>;

/** `template` with the manifest's version in place of `{version}`. */
function expandVersion(manifest: VersionedManifest, template: string): string {
  return template.replaceAll(VERSION_PLACEHOLDER, manifest.version);
}

/** The tag of the manifest version's GitHub release: the version in its `pkg:github` purl. */
function releaseTag(manifest: VersionedManifest): string {
  const tag = manifest.purl.slice(manifest.purl.indexOf("@") + 1);
  try {
    return decodeURIComponent(expandVersion(manifest, tag));
  } catch (error) {
    throw new Error(`${manifest.name}.json: the purl's version ${tag} is not URL-encoded`, {
      cause: error,
    });
  }
}

/** Throws unless every key of `sha256` is `<release tag>/<target>` for the manifest's version. */
function checkPinKeys(file: string, manifest: VersionedManifest, sha256: Record<string, string>) {
  if (!manifest.purl.startsWith(GITHUB_PURL_PREFIX)) {
    throw new Error(`${file}: "sha256" pins GitHub release assets, so "purl" must be pkg:github`);
  }
  const tag = releaseTag(manifest);
  // Renovate's manager reads the tag as the part of the key before its first `/`.
  if (tag.includes("/")) throw new Error(`${file}: release tag ${tag} cannot key "sha256"`);
  for (const key of Object.keys(sha256)) {
    const target = key.slice(tag.length + 1);
    if (!key.startsWith(`${tag}/`) || !target || target.includes("/")) {
      throw new Error(`${file}: "sha256" key ${key} is not "${tag}/<target>"`);
    }
  }
}

/**
 * The pinned SHA256 of the asset the manifest's script downloads for `target` from the manifest
 * version's GitHub release. Throws when there is none.
 */
export async function manifestSha256(name: string, target: string): Promise<string> {
  const manifest = await readManifest(name);
  if (!("version" in manifest)) throw new Error(`${name}.json has no version`);
  const key = `${releaseTag(manifest)}/${target}`;
  const sha256 = manifest.sha256?.[key];
  if (!sha256) throw new Error(`${name}.json pins no SHA256 for ${key}`);
  return sha256;
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
