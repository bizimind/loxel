/**
 * Writes Loxel's CycloneDX SBOM to a file:
 *
 *   bun scripts/sbom.ts <out.cdx.json>
 *
 * The base is pnpm's SBOM of loxel's `dependencies`, which in this package are what ships (Vite
 * bundles them, or a language server is built from them), so it lists each with its whole
 * dependency tree. Run it after `pnpm install`, since pnpm reads licenses from the installed
 * packages. To it are added what the lockfile does not hold: the patched Electron, the Bun runtime
 * that `bun build --compile` puts in loxel-server and the compiled language servers, and the
 * component each language server manifest names (see language-server-manifest.ts).
 */

import path from "node:path";

import { $ } from "bun";
import { z } from "zod";

import { electronVersion, type Patch, readPatches } from "./electron-dist";
import {
  type Manifest,
  readAllManifests,
  readManifests,
  type ShippedComponent,
  shippedComponent,
} from "./language-server-manifest";

const LOXEL = path.resolve(import.meta.dir, "..");
const REPO_ROOT = path.resolve(LOXEL, "..", "..");
const REPO_URL = "https://github.com/bizimind/loxel";

const ComponentSchema = z.looseObject({ "bom-ref": z.string() });
const BomSchema = z.looseObject({
  metadata: z.looseObject({
    component: z.looseObject({ "bom-ref": z.string(), version: z.string() }),
  }),
  components: z.array(ComponentSchema),
  dependencies: z.array(
    z.looseObject({ ref: z.string(), dependsOn: z.array(z.string()).optional() }),
  ),
});

export type Bom = z.infer<typeof BomSchema>;
type Component = z.infer<typeof ComponentSchema>;

/** Electron as Loxel ships it: the pinned release with Loxel's patches, each linked at the tag. */
export function electronComponent(
  version: string,
  patches: Patch[],
  loxelVersion: string,
): Component {
  const purl = `pkg:npm/electron@${version}`;
  return {
    type: "framework",
    "bom-ref": purl,
    name: "electron",
    version,
    purl,
    licenses: [{ expression: "MIT" }],
    pedigree: {
      patches: patches.map((patch) => ({
        type: "unofficial",
        diff: {
          url: `${REPO_URL}/blob/loxel-v${loxelVersion}/packages/loxel/electron/patches/${patch.name}`,
        },
      })),
    },
  };
}

/** The Bun runtime compiled into loxel-server and the Bun-compiled language servers. */
export function bunComponent(version: string): Component {
  const purl = `pkg:github/oven-sh/bun@bun-v${version}`;
  return {
    type: "platform",
    "bom-ref": purl,
    name: "bun",
    version,
    purl,
    licenses: [{ expression: "MIT" }],
  };
}

export function languageServerComponent(shipped: ShippedComponent): Component {
  return {
    type: "application",
    "bom-ref": shipped.purl,
    name: shipped.name,
    version: shipped.version,
    purl: shipped.purl,
    licenses: [{ expression: shipped.license }],
    ...(shipped.source && { externalReferences: [{ type: "vcs", url: shipped.source }] }),
  };
}

/** `bom` with `components` added and made dependencies of its root. Throws on a duplicate. */
export function withComponents(bom: Bom, components: Component[]): Bom {
  const refs = new Set(bom.components.map((component) => component["bom-ref"]));
  for (const component of components) {
    if (refs.has(component["bom-ref"])) throw new Error(`${component["bom-ref"]} is listed twice`);
    refs.add(component["bom-ref"]);
  }
  const rootRef = bom.metadata.component["bom-ref"];
  const added = components.map((component) => component["bom-ref"]);
  const hasRoot = bom.dependencies.some((dependency) => dependency.ref === rootRef);
  const dependencies = hasRoot
    ? bom.dependencies.map((dependency) =>
        dependency.ref === rootRef
          ? { ...dependency, dependsOn: [...(dependency.dependsOn ?? []), ...added] }
          : dependency,
      )
    : [...bom.dependencies, { ref: rootRef, dependsOn: added }];
  return { ...bom, components: [...bom.components, ...components], dependencies };
}

/**
 * Throws unless every npm package a manifest is built from is in loxel's `dependencies`: the
 * pnpm SBOM covers only those, so a server built from a devDependency would be missing from it.
 */
export function checkNpmDependencies(manifests: Manifest[], packageJson: unknown): void {
  const dependencies = z
    .object({ dependencies: z.record(z.string(), z.string()) })
    .parse(packageJson).dependencies;
  const missing = manifests.flatMap((manifest) =>
    (manifest.npm ?? [])
      .filter((name) => !(name in dependencies))
      .map((name) => `${name} (${manifest.name}.json)`),
  );
  if (missing.length > 0) {
    throw new Error(`Not in loxel's dependencies, so missing from the SBOM: ${missing.join(", ")}`);
  }
}

/** The SBOM of the app built on this platform. */
export async function generateSbom(): Promise<Bom> {
  const packageJson: unknown = await Bun.file(path.join(LOXEL, "package.json")).json();
  checkNpmDependencies(await readAllManifests(), packageJson);

  const pnpmSbom: unknown =
    await $`pnpm --filter loxel sbom --sbom-format cyclonedx --sbom-type application --prod`
      .cwd(LOXEL)
      .quiet()
      .json();
  const bom = BomSchema.parse(pnpmSbom);

  const bunVersion = (await Bun.file(path.join(REPO_ROOT, ".bun-version")).text()).trim();
  const languageServers = (await readManifests())
    .map(shippedComponent)
    .filter((shipped) => shipped !== undefined)
    .map(languageServerComponent);
  return withComponents(bom, [
    electronComponent(electronVersion(packageJson), readPatches(), bom.metadata.component.version),
    bunComponent(bunVersion),
    ...languageServers,
  ]);
}

if (import.meta.main) {
  const out = Bun.argv[2];
  if (!out) throw new Error("Usage: bun scripts/sbom.ts <out.cdx.json>");
  const bom = await generateSbom();
  await Bun.write(out, `${JSON.stringify(bom, null, 2)}\n`);
  console.log(`Wrote ${out}: ${bom.components.length} components`);
}
