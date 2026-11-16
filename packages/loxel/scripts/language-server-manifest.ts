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
 */

import { readdirSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

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

/** The manifest `scripts/language-servers/<name>.json`. Throws when it is missing or invalid. */
export async function readManifest(name: string): Promise<Manifest> {
  const file = path.join(MANIFEST_DIR, `${name}.json`);
  const parsed = ManifestSchema.safeParse(await Bun.file(file).json());
  if (!parsed.success) throw new Error(`${file}: ${z.prettifyError(parsed.error)}`);
  return { ...parsed.data, name };
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

/** The component a manifest ships, or undefined when it is built only from npm packages. */
export function shippedComponent(manifest: Manifest): ShippedComponent | undefined {
  if (!("version" in manifest)) return undefined;
  const { version } = manifest;
  const expand = (template: string) => template.replaceAll(VERSION_PLACEHOLDER, version);
  // The purl's name, `pkg:<type>/<namespace>/<name>@<version>`: what the version is a version of.
  const unversioned = manifest.purl.slice(0, manifest.purl.indexOf("@"));
  return {
    name: unversioned.slice(unversioned.lastIndexOf("/") + 1),
    version,
    purl: expand(manifest.purl),
    license: manifest.license,
    source: manifest.source === undefined ? undefined : expand(manifest.source),
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
