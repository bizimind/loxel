/**
 * Writes Loxel's CycloneDX SBOM to a file:
 *
 *   bun scripts/sbom.ts <out.cdx.json>
 *
 * The base is pnpm's SBOM of loxel's `dependencies`, which in this package are what ships (Vite
 * bundles them, or a language server is built from them), so it lists each with its whole
 * dependency tree. Run it after `pnpm install`, since pnpm reads licenses from the installed
 * packages. To it are added what the lockfile does not hold: the patched Electron and the Bun
 * runtime that `bun build --compile` puts in loxel-server and the compiled language servers, each
 * with what it bundles (third-party.json); the other things that ship without being packages
 * (third-party.json); the component each language server manifest names (see
 * language-server-manifest.ts); and, read from the built language servers, the Go modules and
 * standard library compiled into each Go binary and the Maven artifacts among their jars. Last,
 * sbom-licenses.ts fills in the licenses those sources leave out. Build the server and language
 * servers first (`pnpm run build:server:standalone`).
 */

import { existsSync } from "node:fs";
import path from "node:path";

import { $ } from "bun";
import { z } from "zod";

import { electronVersion, type Patch, readPatches } from "./electron-dist";
import { findGoBinaries, type GoBuildInfo, type GoModule } from "./go-build-info";
import { findJars, type MavenCoordinates } from "./jar-coordinates";
import {
  type Manifest,
  readAllManifests,
  readManifests,
  type ShippedComponent,
  shippedComponent,
} from "./language-server-manifest";
import {
  joinExpressions,
  LicenseOverrideSchema,
  withDepsDevLicenses,
  withLicenseOverrides,
  withNpmLegacyLicenses,
} from "./sbom-licenses";

const LOXEL = path.resolve(import.meta.dir, "..");
const REPO_ROOT = path.resolve(LOXEL, "..", "..");
const REPO_URL = "https://github.com/bizimind/loxel";
/** Where `language-server-binaries.ts build` stages what ships next to loxel-server. */
const STAGED_LANGUAGE_SERVERS = path.join(LOXEL, "build", "language-servers");
/** The compiled server, which `build-server.ts compile` writes. */
const SERVER_BINARY = path.join(LOXEL, "build", "loxel-server");
/** pnpm's store of the installed packages, `<name>@<version>/node_modules/<name>`. */
const PNPM_STORE = path.join(REPO_ROOT, "node_modules", ".pnpm");

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
export type Component = z.infer<typeof ComponentSchema>;

/** Something that ships without a package of its own, or that Electron or Bun bundles. */
const ThirdPartyEntrySchema = z.strictObject({
  name: z.string(),
  version: z.string().optional(),
  /** Bun's only: the `process.versions` key the shipped Bun reports the version in. */
  versionKey: z.string().optional(),
  /** With `{version}` standing for the version. */
  purl: z.string().optional(),
  license: z.string(),
  url: z.string(),
  note: z.string().optional(),
});
const ThirdPartySchema = z.strictObject({
  note: z.string(),
  licenses: z.record(z.string(), LicenseOverrideSchema),
  components: z.array(ThirdPartyEntrySchema),
  electron: z.strictObject({
    version: z.string(),
    note: z.string(),
    components: z.array(ThirdPartyEntrySchema),
  }),
  bun: z.strictObject({ note: z.string(), components: z.array(ThirdPartyEntrySchema) }),
});

type ThirdPartyEntry = z.infer<typeof ThirdPartyEntrySchema>;
export type ThirdParty = z.infer<typeof ThirdPartySchema>;

export async function readThirdParty(): Promise<ThirdParty> {
  return ThirdPartySchema.parse(await Bun.file(path.join(LOXEL, "third-party.json")).json());
}

function thirdPartyComponent(entry: ThirdPartyEntry, version = entry.version): Component {
  const purl = version && entry.purl?.replaceAll("{version}", version);
  return {
    type: "library",
    "bom-ref": purl || (version ? `${entry.name}@${version}` : entry.name),
    name: entry.name,
    ...(version && { version }),
    ...(purl && { purl }),
    licenses: [{ expression: entry.license }],
    externalReferences: [{ type: "website", url: entry.url }],
    ...(entry.note && { description: entry.note }),
  };
}

/**
 * A binary with what it bundles, each a dependency of it: the binary's license is its own and
 * theirs together, since it holds them all.
 */
function bundleAdditions(
  binary: Component,
  ownLicense: string,
  bundled: Array<{ entry: ThirdPartyEntry; version?: string }>,
): Addition[] {
  const license = joinExpressions(
    [ownLicense, ...bundled.map(({ entry }) => entry.license)],
    "AND",
  );
  return [
    { component: { ...binary, licenses: [{ expression: license }] } },
    ...bundled.map(({ entry, version }) => ({
      component: thirdPartyComponent(entry, version),
      parents: [binary["bom-ref"]],
    })),
  ];
}

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

/** Electron and what it bundles, which third-party.json must list for the pinned `version`. */
export function electronAdditions(
  version: string,
  patches: Patch[],
  loxelVersion: string,
  bundled: ThirdParty["electron"],
): Addition[] {
  if (bundled.version !== version) {
    throw new Error(
      `third-party.json lists what Electron ${bundled.version} bundles, but package.json pins ${version}: update its "electron"`,
    );
  }
  return bundleAdditions(
    electronComponent(version, patches, loxelVersion),
    "MIT",
    bundled.components.map((entry) => ({ entry })),
  );
}

/** The Bun runtime compiled into loxel-server and the Bun-compiled language servers. */
export function bunComponent(version: string): Component {
  const purl = `pkg:github/oven-sh/bun@bun-v${version}`;
  return { type: "platform", "bom-ref": purl, name: "bun", version, purl };
}

/**
 * Bun and what it links, at the versions the shipped Bun reports in `process.versions`
 * (`versions`). Throws when it no longer reports one third-party.json names.
 */
export function bunAdditions(
  versions: Record<string, string | undefined>,
  bundled: ThirdParty["bun"],
): Addition[] {
  const { bun } = versions;
  if (!bun) throw new Error("process.versions has no bun");
  return bundleAdditions(
    bunComponent(bun),
    "MIT",
    bundled.components.map((entry) => {
      if (!entry.versionKey) return { entry };
      const version = versions[entry.versionKey];
      if (!version) {
        throw new Error(
          `Bun ${bun} has no process.versions.${entry.versionKey} (third-party.json)`,
        );
      }
      return { entry, version };
    }),
  );
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
  const found = binaries.flatMap(({ file, info }) => {
    const main = info.main && info.main.version !== "(devel)" ? [info.main] : [];
    const components = [
      goStdlibComponent(info.goVersion),
      ...[...main, ...info.deps].map(goModuleComponent),
    ];
    return components.map((component) => ({ component, parent: parentOf(file) }));
  });
  return uniqueAdditions(found, skip);
}

/** A Maven artifact, from a jar's coordinates. */
export function mavenComponent({ groupId, artifactId, version }: MavenCoordinates): Component {
  const purl = `pkg:maven/${groupId}/${artifactId}@${encodeURIComponent(version)}`;
  return { type: "library", "bom-ref": purl, group: groupId, name: artifactId, version, purl };
}

/**
 * The Maven artifacts among the jars, each a dependency of `parentOf(file)`, as goAdditions. A
 * `-SNAPSHOT` is the server's own build, like a Go `(devel)` module: no artifact anyone can look up.
 */
export function jarAdditions(
  jars: Array<{ file: string; coordinates: MavenCoordinates[] }>,
  parentOf: (file: string) => string,
  skip: ReadonlySet<string>,
): Addition[] {
  const found = jars.flatMap(({ file, coordinates }) =>
    coordinates
      .filter(({ version }) => !version.endsWith("-SNAPSHOT"))
      .map((coordinate) => ({ component: mavenComponent(coordinate), parent: parentOf(file) })),
  );
  return uniqueAdditions(found, skip);
}

/** One addition per component, with every parent it was found under; those in `skip` left out. */
function uniqueAdditions(
  found: Array<{ component: Component; parent: string }>,
  skip: ReadonlySet<string>,
): Addition[] {
  const additions = new Map<string, Addition & { parents: string[] }>();
  for (const { component, parent } of found) {
    const ref = component["bom-ref"];
    if (skip.has(ref) || ref === parent) continue;
    const existing = additions.get(ref);
    if (!existing) additions.set(ref, { component, parents: [parent] });
    else if (!existing.parents.includes(parent)) existing.parents.push(parent);
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
 * platform packages (TypeScript's compiler is one), so each architecture's app gets its own.
 * `bunVersions` is the shipped Bun's `process.versions`. With `languageServersDir`, the Go binaries
 * and jars in it add their modules and artifacts.
 */
export async function generateSbom(
  bunVersions: Record<string, string | undefined>,
  languageServersDir?: string,
): Promise<Bom> {
  const packageJson: unknown = await Bun.file(path.join(LOXEL, "package.json")).json();
  checkNpmDependencies(await readAllManifests(), packageJson);
  const thirdParty = await readThirdParty();

  const pnpmSbom: unknown =
    await $`pnpm --filter @bizimind/loxel sbom --sbom-format cyclonedx --sbom-type application --prod`
      .cwd(LOXEL)
      .quiet()
      .json();
  const bom = BomSchema.parse(pnpmSbom);
  const { version } = bom.metadata.component;
  // pnpm names the root as an npm package, which Loxel is not.
  bom.metadata.component.purl = `pkg:github/bizimind/loxel@loxel-v${version}`;

  const manifests = await readManifests();
  const languageServers = manifests.flatMap((manifest) => {
    const shipped = shippedComponent(manifest);
    return shipped ? [{ manifest, shipped }] : [];
  });
  let full = withComponents(bom, [
    ...electronAdditions(electronVersion(packageJson), readPatches(), version, thirdParty.electron),
    ...bunAdditions(bunVersions, thirdParty.bun),
    ...thirdParty.components.map((entry) => ({ component: thirdPartyComponent(entry) })),
    ...languageServers.map(({ shipped }) => ({ component: languageServerComponent(shipped) })),
  ]);

  if (languageServersDir) {
    // A staged file belongs to the manifest whose resource it is staged from (`typescript-lib/tsc`
    // to the one staging `typescript-lib`); one built from npm packages has no component of its
    // own.
    const rootRef = bom.metadata.component["bom-ref"];
    const parentOf = (file: string): string => {
      const staged = file.split(path.sep)[0];
      const owner = languageServers.find(({ manifest }) =>
        manifest.resources.some((resource) => path.basename(resource) === staged),
      );
      return owner?.shipped.purl ?? rootRef;
    };
    const existing = new Set(full.components.map((component) => component["bom-ref"]));
    full = withComponents(full, [
      ...goAdditions(await findGoBinaries(languageServersDir), parentOf, existing),
      ...jarAdditions(await findJars(languageServersDir), parentOf, existing),
    ]);
  }

  // The overrides first, so the lookups, which only fill in missing licenses, skip them. Without
  // the language servers there are no Go modules or jars for theirs to match.
  const overrides = Object.entries(thirdParty.licenses).filter(
    ([ref]) => languageServersDir || !/^pkg:(golang|maven)\//.test(ref),
  );
  let components = withLicenseOverrides(full.components, Object.fromEntries(overrides));
  components = await withNpmLegacyLicenses(components, PNPM_STORE);
  components = await withDepsDevLicenses(components);
  return sorted({ ...full, components });
}

/** `bom` in a fixed order, since pnpm lists its components in a different one each run. */
export function sorted(bom: Bom): Bom {
  const compare = (a: string, b: string): number => (a < b ? -1 : 1);
  return {
    ...bom,
    components: bom.components.toSorted((a, b) => compare(a["bom-ref"], b["bom-ref"])),
    dependencies: bom.dependencies
      .map((dependency) => ({ ...dependency, dependsOn: dependency.dependsOn?.toSorted() }))
      .toSorted((a, b) => compare(a.ref, b.ref)),
  };
}

/** The `process.versions` of the Bun compiled into `binary`, which runs as Bun with BUN_BE_BUN. */
async function shippedBunVersions(binary: string): Promise<Record<string, string>> {
  const output = await $`${binary} -e ${"console.log(JSON.stringify(process.versions))"}`
    .env({ ...process.env, BUN_BE_BUN: "1" })
    .quiet()
    .json();
  return z.record(z.string(), z.string()).parse(output);
}

if (import.meta.main) {
  const out = Bun.argv[2];
  if (!out) throw new Error("Usage: bun scripts/sbom.ts <out.cdx.json>");
  for (const built of [STAGED_LANGUAGE_SERVERS, SERVER_BINARY]) {
    if (!existsSync(built)) {
      throw new Error(
        `${built} is missing: build the server and language servers first (pnpm run build:server:standalone)`,
      );
    }
  }
  const bom = await generateSbom(await shippedBunVersions(SERVER_BINARY), STAGED_LANGUAGE_SERVERS);
  await Bun.write(out, `${JSON.stringify(bom, null, 2)}\n`);
  const unlicensed = bom.components.filter((component) => !component.licenses);
  console.log(
    `Wrote ${out}: ${bom.components.length} components, ${unlicensed.length} without a license`,
  );
}
