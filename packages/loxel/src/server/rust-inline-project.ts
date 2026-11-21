/**
 * rust-analyzer's inline project for a Cargo workspace, built from what `cargo metadata --no-deps`
 * reports. Loading a `Cargo.toml` itself makes the server run `cargo metadata` with dependencies,
 * which asks `rustc` about the target in an environment the workspace's Cargo configuration sets;
 * an inline project needs neither, so the server runs nothing from the workspace for it.
 */
import path from "node:path";

import { isRecord } from "@/lib/is-record";

/** The target kinds a package's library has: the target other crates depend on. */
const LIBRARY_KINDS: ReadonlySet<string> = new Set([
  "lib",
  "rlib",
  "dylib",
  "cdylib",
  "staticlib",
  "proc-macro",
]);
const BUILD_SCRIPT_KIND = "custom-build";

/** Cfgs every crate is analyzed with, as rust-analyzer sets them for a Cargo workspace member. */
const MEMBER_CFGS = ["debug_assertions"];

/**
 * The editions rust-analyzer's project format takes. A value it rejects would make it drop all the
 * linked projects and look for a `Cargo.toml` itself, so a target with any other is left out.
 */
const EDITIONS: ReadonlySet<string> = new Set(["2015", "2018", "2021", "2024"]);

/** Cargo's own rule for feature names, so a feature always makes a well-formed cfg. */
const FEATURE_NAME = /^[\w][\w+.-]*$/;

export interface CargoTarget {
  name: string;
  kind: string[];
  srcPath: string;
  edition: string;
}

export interface CargoDependency {
  name: string;
  rename: string | null;
  /** Null for a normal dependency. */
  kind: "dev" | "build" | null;
  /** Set for a path dependency: the directory of its package. */
  path: string | null;
}

/** A workspace package, as far as the inline project needs it. */
export interface CargoPackage {
  name: string;
  version: string;
  manifestPath: string;
  targets: CargoTarget[];
  dependencies: CargoDependency[];
  features: Record<string, string[]>;
}

/** The packages of `cargo metadata --format-version 1` output, and none when it is not that. */
export function parseCargoPackages(stdout: string): CargoPackage[] {
  let metadata: unknown;
  try {
    metadata = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!isRecord(metadata) || !Array.isArray(metadata.packages)) return [];
  return metadata.packages.flatMap((entry) => {
    const pkg = readPackage(entry);
    return pkg ? [pkg] : [];
  });
}

function readPackage(entry: unknown): CargoPackage | null {
  if (!isRecord(entry)) return null;
  const { name, version, manifest_path: manifestPath, edition } = entry;
  if (typeof name !== "string" || typeof version !== "string") return null;
  if (typeof manifestPath !== "string" || !path.isAbsolute(manifestPath)) return null;
  const packageEdition = typeof edition === "string" ? edition : "2015";
  const targets = (Array.isArray(entry.targets) ? entry.targets : []).flatMap((target) => {
    const read = readTarget(target, packageEdition);
    return read ? [read] : [];
  });
  const dependencies = (Array.isArray(entry.dependencies) ? entry.dependencies : []).flatMap(
    (dependency) => {
      const read = readDependency(dependency);
      return read ? [read] : [];
    },
  );
  return { name, version, manifestPath, targets, dependencies, features: readFeatures(entry) };
}

function readTarget(target: unknown, packageEdition: string): CargoTarget | null {
  if (!isRecord(target)) return null;
  const { name, kind, src_path: srcPath, edition } = target;
  if (typeof name !== "string" || typeof srcPath !== "string" || !path.isAbsolute(srcPath)) {
    return null;
  }
  if (!Array.isArray(kind) || !kind.every((item) => typeof item === "string")) return null;
  const targetEdition = typeof edition === "string" ? edition : packageEdition;
  if (!EDITIONS.has(targetEdition)) return null;
  return { name, kind, srcPath, edition: targetEdition };
}

function readDependency(dependency: unknown): CargoDependency | null {
  if (!isRecord(dependency) || typeof dependency.name !== "string") return null;
  const { kind, rename, path: dependencyPath } = dependency;
  return {
    name: dependency.name,
    rename: typeof rename === "string" ? rename : null,
    kind: kind === "dev" || kind === "build" ? kind : null,
    path:
      typeof dependencyPath === "string" && path.isAbsolute(dependencyPath) ? dependencyPath : null,
  };
}

function readFeatures(entry: Record<string, unknown>): Record<string, string[]> {
  const features: Record<string, string[]> = {};
  if (!isRecord(entry.features)) return features;
  for (const [feature, implied] of Object.entries(entry.features)) {
    if (FEATURE_NAME.test(feature) && Array.isArray(implied)) {
      features[feature] = implied.filter((item): item is string => typeof item === "string");
    }
  }
  return features;
}

/** The package's own features its default set turns on, `default` included. */
function defaultFeatures(features: Record<string, string[]>): string[] {
  const enabled = new Set<string>();
  const enable = (feature: string) => {
    if (enabled.has(feature) || !(feature in features)) return;
    enabled.add(feature);
    // `dep:x`, `x/y` and `x?/y` name dependencies, which this project does not load.
    for (const implied of features[feature] ?? []) enable(implied);
  };
  enable("default");
  return [...enabled].toSorted();
}

const crateName = (name: string) => name.replaceAll("-", "_");

const isLibrary = (target: CargoTarget) => target.kind.some((kind) => LIBRARY_KINDS.has(kind));

/**
 * The crates of `packages`, for a project in `rust-project.json`'s format. A target depends on the
 * libraries of the workspace packages its package names by path, and a package's other targets on
 * its own library; a build script on its build dependencies only. Dependencies from a registry or
 * git are not in the workspace's metadata, so they stay out.
 */
export function inlineCargoCrates(packages: readonly CargoPackage[]): Record<string, unknown>[] {
  const entries = packages.flatMap((pkg) => pkg.targets.map((target) => ({ pkg, target })));
  const libraries = new Map<string, { index: number; name: string }>();
  entries.forEach(({ pkg, target }, index) => {
    const dir = path.dirname(pkg.manifestPath);
    if (isLibrary(target) && !libraries.has(dir)) libraries.set(dir, { index, name: target.name });
  });

  return entries.map(({ pkg, target }, index) => {
    const dir = path.dirname(pkg.manifestPath);
    const buildScript = target.kind.includes(BUILD_SCRIPT_KIND);
    const deps: { crate: number; name: string }[] = [];
    const own = libraries.get(dir);
    if (own && own.index !== index && !buildScript) {
      deps.push({ crate: own.index, name: crateName(own.name) });
    }
    for (const dependency of pkg.dependencies) {
      if ((dependency.kind === "build") !== buildScript || !dependency.path) continue;
      const library = libraries.get(path.resolve(dependency.path));
      if (!library || library.index === index || deps.some((dep) => dep.crate === library.index)) {
        continue;
      }
      deps.push({ crate: library.index, name: crateName(dependency.rename ?? library.name) });
    }
    return {
      display_name: target.name,
      root_module: target.srcPath,
      edition: target.edition,
      deps,
      cfg: [...MEMBER_CFGS, ...defaultFeatures(pkg.features).map((name) => `feature="${name}"`)],
      env: {
        CARGO_PKG_NAME: pkg.name,
        CARGO_PKG_VERSION: pkg.version,
        CARGO_MANIFEST_DIR: dir,
        CARGO_CRATE_NAME: crateName(target.name),
      },
      is_workspace_member: true,
      is_proc_macro: target.kind.includes("proc-macro"),
      source: { include_dirs: [dir], exclude_dirs: [path.join(dir, "target")] },
    };
  });
}
