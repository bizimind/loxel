/**
 * Writes Loxel's CycloneDX SBOM to a file:
 *
 *   bun scripts/sbom.ts <out.cdx.json>
 *
 * The base is pnpm's SBOM of loxel's `dependencies`, which in this package are what ships (Vite
 * bundles them, or a language server is built from them), so it lists each with its whole
 * dependency tree. Run it after `pnpm install`, since pnpm reads licenses from the installed
 * packages. To it are added what the lockfile does not hold: the patched Electron, the Bun runtime
 * that `bun build --compile` puts in loxel-server and the compiled language servers, the component
 * each language server manifest names (see language-server-manifest.ts), and, read from each Go
 * binary among the built language servers, the Go modules and standard library compiled into it.
 * The language servers must be built and staged first (`pnpm run build:server:standalone`).
 */

import { existsSync } from "node:fs";
import path from "node:path";

import { $ } from "bun";
import { z } from "zod";

import { electronVersion, type Patch, readPatches } from "./electron-dist";
import { findGoBinaries, type GoBuildInfo, type GoModule } from "./go-build-info";
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
/** Where `language-server-binaries.ts build` stages what ships next to loxel-server. */
const STAGED_LANGUAGE_SERVERS = path.join(LOXEL, "build", "language-servers");

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

/** A Go module as scanners name it: the path lowercased, `+` in the version escaped. */
export function goModuleComponent(module: GoModule): Component {
  const purl = `pkg:golang/${module.path.toLowerCase()}@${encodeURIComponent(module.version)}`;
  return { type: "library", "bom-ref": purl, name: module.path, version: module.version, purl };
}

/** The Go standard library a binary was built with (`go1.26.4` is `v1.26.4`). */
export function goStdlibComponent(goVersion: string): Component {
  const version = (goVersion.split(" ")[0] ?? goVersion).replace(/^go/, "v");
  const purl = `pkg:golang/stdlib@${version}`;
  return {
    type: "library",
    "bom-ref": purl,
    name: "stdlib",
    version,
    purl,
    licenses: [{ expression: "BSD-3-Clause" }],
  };
}

/** A component to add, and the refs that depend on it (the SBOM's root when none are given). */
export interface Addition {
  component: Component;
  parents?: string[];
}

/**
 * What each Go binary compiles in: its standard library, its main module when it has a version,
 * and its dependencies, each a dependency of `parentOf(file)`. A module in several binaries is one
 * component with several parents; one whose ref is in `skip` (the binary's own component) is left
 * out.
 */
export function goAdditions(
  binaries: Array<{ file: string; info: GoBuildInfo }>,
  parentOf: (file: string) => string,
  skip: ReadonlySet<string>,
): Addition[] {
  const additions = new Map<string, Addition & { parents: string[] }>();
  for (const { file, info } of binaries) {
    const parent = parentOf(file);
    const main = info.main && info.main.version !== "(devel)" ? [info.main] : [];
    const components = [
      goStdlibComponent(info.goVersion),
      ...[...main, ...info.deps].map(goModuleComponent),
    ];
    for (const component of components) {
      const ref = component["bom-ref"];
      if (skip.has(ref) || ref === parent) continue;
      const existing = additions.get(ref);
      if (!existing) additions.set(ref, { component, parents: [parent] });
      else if (!existing.parents.includes(parent)) existing.parents.push(parent);
    }
  }
  return [...additions.values()];
}

/** `bom` with the components added as dependencies of their parents. Throws on a duplicate. */
export function withComponents(bom: Bom, additions: Addition[]): Bom {
  const refs = new Set(bom.components.map((component) => component["bom-ref"]));
  for (const { component } of additions) {
    if (refs.has(component["bom-ref"])) throw new Error(`${component["bom-ref"]} is listed twice`);
    refs.add(component["bom-ref"]);
  }
  const rootRef = bom.metadata.component["bom-ref"];
  const edges = new Map<string, string[]>();
  for (const { component, parents = [rootRef] } of additions) {
    for (const parent of parents) {
      edges.set(parent, [...(edges.get(parent) ?? []), component["bom-ref"]]);
    }
  }
  const dependencies = bom.dependencies.map((dependency) => {
    const added = edges.get(dependency.ref);
    if (!added) return dependency;
    edges.delete(dependency.ref);
    return { ...dependency, dependsOn: [...(dependency.dependsOn ?? []), ...added] };
  });
  for (const [ref, dependsOn] of edges) dependencies.push({ ref, dependsOn });
  return {
    ...bom,
    components: [...bom.components, ...additions.map(({ component }) => component)],
    dependencies,
  };
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

/**
 * The SBOM of the app built on this machine. pnpm installs, and so lists, only this machine's
 * platform packages (TypeScript's compiler is one), so each architecture's app gets its own. With
 * `languageServersDir`, the Go binaries in it add their modules.
 */
export async function generateSbom(languageServersDir?: string): Promise<Bom> {
  const packageJson: unknown = await Bun.file(path.join(LOXEL, "package.json")).json();
  checkNpmDependencies(await readAllManifests(), packageJson);

  const pnpmSbom: unknown =
    await $`pnpm --filter @bizimind/loxel sbom --sbom-format cyclonedx --sbom-type application --prod`
      .cwd(LOXEL)
      .quiet()
      .json();
  const bom = BomSchema.parse(pnpmSbom);
  const { version } = bom.metadata.component;
  // pnpm names the root as an npm package, which Loxel is not.
  bom.metadata.component.purl = `pkg:github/bizimind/loxel@loxel-v${version}`;

  const bunVersion = (await Bun.file(path.join(REPO_ROOT, ".bun-version")).text()).trim();
  const manifests = await readManifests();
  const languageServers = manifests.flatMap((manifest) => {
    const shipped = shippedComponent(manifest);
    return shipped ? [{ manifest, shipped }] : [];
  });
  const base = withComponents(
    bom,
    [
      electronComponent(electronVersion(packageJson), readPatches(), version),
      bunComponent(bunVersion),
      ...languageServers.map(({ shipped }) => languageServerComponent(shipped)),
    ].map((component) => ({ component })),
  );
  if (!languageServersDir) return base;

  // A staged binary belongs to the manifest whose resource it is staged from (`typescript-lib/tsc`
  // to the one staging `typescript-lib`); one built from npm packages has no component of its own.
  const rootRef = bom.metadata.component["bom-ref"];
  const parentOf = (file: string): string => {
    const staged = file.split(path.sep)[0];
    const owner = languageServers.find(({ manifest }) =>
      manifest.resources.some((resource) => path.basename(resource) === staged),
    );
    return owner?.shipped.purl ?? rootRef;
  };
  const existing = new Set(base.components.map((component) => component["bom-ref"]));
  const binaries = await findGoBinaries(languageServersDir);
  return withComponents(base, goAdditions(binaries, parentOf, existing));
}

if (import.meta.main) {
  const out = Bun.argv[2];
  if (!out) throw new Error("Usage: bun scripts/sbom.ts <out.cdx.json>");
  if (!existsSync(STAGED_LANGUAGE_SERVERS)) {
    throw new Error(
      `${STAGED_LANGUAGE_SERVERS} is missing: build the language servers first (pnpm run build:server:standalone)`,
    );
  }
  const bom = await generateSbom(STAGED_LANGUAGE_SERVERS);
  await Bun.write(out, `${JSON.stringify(bom, null, 2)}\n`);
  console.log(`Wrote ${out}: ${bom.components.length} components`);
}
