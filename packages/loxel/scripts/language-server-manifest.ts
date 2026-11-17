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
 * in `purl` and `source` stands for it. A Go server built from a pinned module names the module's
 * directory in `goModule` instead of a `version`: its version is the one that module's go.mod
 * requires (of the module in its `pkg:golang` purl), so a bump of the go.mod (Dependabot's) is the
 * whole upgrade. `source`, `licenseFile` and `note` are for its notice.
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
  BaseSchema.extend({
    // A directory under scripts/ holding the go.mod that pins the server.
    goModule: z.string().min(1),
    purl: z.string().regex(/^pkg:golang\/[^@]+@v\{version\}$/),
    license: z.string().min(1),
  }),
  BaseSchema.extend({ npm: z.array(z.string()).nonempty() }),
]);

type ParsedManifest = z.infer<typeof ManifestSchema>;
/** A `goModule` manifest gets the version its go.mod requires. */
type Resolved<T> = T extends { goModule: string } ? T & { version: string } : T;
export type Manifest = Resolved<ParsedManifest> & { name: string };

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
  if (!parsed.success) {
    const hint = 'it needs "npm", or "version" (or "goModule"), "purl" and "license"';
    throw new Error(`${file}: ${hint}\n${z.prettifyError(parsed.error)}`);
  }
  const manifest = parsed.data;
  if (!("goModule" in manifest)) return { ...manifest, name };
  const modulePath = manifest.purl.slice("pkg:golang/".length, manifest.purl.indexOf("@"));
  const version = await goModRequiredVersion(
    path.join(import.meta.dir, manifest.goModule),
    modulePath,
  );
  return { ...manifest, name, version };
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

/** The version, without its `v`, of `modulePath` that the go.mod in `moduleDir` requires. */
async function goModRequiredVersion(moduleDir: string, modulePath: string): Promise<string> {
  const goMod = await Bun.file(path.join(moduleDir, "go.mod")).text();
  // A lone `require` line, or a line in a `require ( ... )` block (`// indirect` there when only a
  // `tool` directive names the module). Purls lowercase the path, so match it either way.
  const pattern = new RegExp(
    `^(?:require)?[ \\t]+${modulePath.replaceAll(".", "\\.")} v(\\S+)`,
    "mi",
  );
  const version = pattern.exec(goMod)?.[1];
  if (!version)
    throw new Error(`${path.basename(moduleDir)}/go.mod does not require ${modulePath}`);
  return version;
}
