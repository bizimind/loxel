/**
 * Takes some updates back out of a Dependabot npm PR, keeping the others at the versions
 * Dependabot chose.
 *
 * Usage (from a checkout of the PR's head):
 *   bun exclude-deps.ts --base <ref> [<dependency>...]
 *   bun exclude-deps.ts --base <ref> --list
 *
 * `--list` prints the dependencies the PR updates, one per line. Otherwise the manifests and
 * lockfile are reset to HEAD's (discarding changes to them), then every named dependency, which
 * must be one the PR updates, goes back to <ref>'s range and locked version along with everything
 * it pulls in. With no names the tree is left at HEAD's.
 */
import { $ } from "bun";

const DEP_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;
type DepField = (typeof DEP_FIELDS)[number];
type Manifest = Partial<Record<DepField, Record<string, string>>> & Record<string, unknown>;
type LockedDeps = Map<string, string>;

/** What the checks need from a pnpm lockfile. */
interface Lockfile {
  /** Importer paths: "." and each workspace package's directory. */
  importers: string[];
  /** `<importer>\0<name>` -> resolved version (peer suffix dropped) of each direct dependency. */
  direct: LockedDeps;
  /** Every locked `name@version` in the `packages` section. */
  packages: Set<string>;
}

/** Dependency names from the `updated-dependencies` block Dependabot puts in its commit message. */
export function parseUpdatedDependencies(message: string): string[] {
  const block = /^updated-dependencies:\n([\s\S]*?)^\.\.\.$/m.exec(message)?.[1];
  if (!block) return [];
  const names = [...block.matchAll(/^- dependency-name: "?([^"\n]+?)"?$/gm)].map((m) => m[1]);
  return [...new Set(names.filter((name): name is string => name !== undefined))];
}

export function parseLockfile(lockfileYaml: string): Lockfile {
  const lockfile: unknown = Bun.YAML.parse(lockfileYaml);
  if (!isRecord(lockfile) || !isRecord(lockfile.importers)) throw new Error("not a pnpm lockfile");
  const direct: LockedDeps = new Map();
  for (const [importer, sections] of Object.entries(lockfile.importers)) {
    if (!isRecord(sections)) continue;
    for (const field of DEP_FIELDS) {
      const deps = sections[field];
      if (!isRecord(deps)) continue;
      for (const [name, entry] of Object.entries(deps)) {
        if (isRecord(entry) && typeof entry.version === "string") {
          direct.set(`${importer}\0${name}`, entry.version.replace(/\(.*$/, ""));
        }
      }
    }
  }
  const packages = new Set(isRecord(lockfile.packages) ? Object.keys(lockfile.packages) : []);
  return { importers: Object.keys(lockfile.importers), direct, packages };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function manifestOf(importer: string): string {
  return importer === "." ? "package.json" : `${importer}/package.json`;
}

async function readManifest(path: string): Promise<Manifest> {
  const parsed: unknown = await Bun.file(path).json();
  if (!isRecord(parsed)) throw new Error(`${path} is not a JSON object`);
  return parsed as Manifest;
}

async function writeManifest(path: string, manifest: Manifest): Promise<void> {
  await Bun.write(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Sets `name` in each of the manifest's dependency fields that `ranges` names, and drops it from the rest. */
function setRanges(manifest: Manifest, name: string, ranges: Map<DepField, string>): void {
  for (const field of DEP_FIELDS) {
    const range = ranges.get(field);
    const deps = manifest[field];
    if (range !== undefined) manifest[field] = { ...deps, [name]: range };
    else if (deps && name in deps) delete deps[name];
  }
}

function rangesIn(manifest: Manifest, name: string): Map<DepField, string> {
  const ranges = new Map<DepField, string>();
  for (const field of DEP_FIELDS) {
    const range = manifest[field]?.[name];
    if (range !== undefined) ranges.set(field, range);
  }
  return ranges;
}

async function lockfileOnlyInstall(): Promise<void> {
  // Resolves without installing, so no package code or lifecycle script runs.
  await $`pnpm install --lockfile-only --ignore-scripts --config.confirmModulesPurge=false`.quiet();
}

async function main(argv: string[]): Promise<void> {
  const baseIndex = argv.indexOf("--base");
  const base = baseIndex === -1 ? undefined : argv[baseIndex + 1];
  if (!base) throw new Error("usage: exclude-deps.ts --base <ref> (--list | <dependency>...)");
  const rest = argv.filter((_, i) => i !== baseIndex && i !== baseIndex + 1);

  const messages = await $`git log --format=%B%x00 ${base}..HEAD`.text();
  const updated = messages
    .split("\0")
    .map(parseUpdatedDependencies)
    .find((names) => names.length > 0);
  if (!updated) throw new Error(`no Dependabot updated-dependencies block in ${base}..HEAD`);

  if (rest.includes("--list")) {
    process.stdout.write(`${updated.join("\n")}\n`);
    return;
  }

  const excluded = [...new Set(rest)];
  const unknown = excluded.filter((name) => !updated.includes(name));
  if (unknown.length > 0) throw new Error(`not updated by this PR: ${unknown.join(", ")}`);

  const head = parseLockfile(await $`git show HEAD:pnpm-lock.yaml`.text());
  const manifests = head.importers.map(manifestOf);
  await $`git checkout HEAD -- ${manifests} pnpm-lock.yaml`;
  if (excluded.length === 0) return;
  const baseLockfile = parseLockfile(await $`git show ${base}:pnpm-lock.yaml`.text());
  const baseLocked = baseLockfile.direct;
  const headLocked = head.direct;

  // Only direct dependencies can be kept at Dependabot's version: an update to an indirect one
  // would be left at its base version without anyone noticing.
  const directNames = new Set([...headLocked.keys()].map((key) => key.split("\0")[1]));
  const indirect = updated.filter((name) => !excluded.includes(name) && !directNames.has(name));
  if (indirect.length > 0)
    throw new Error(`indirect updates are not supported: ${indirect.join(", ")}`);

  // Re-resolve from the base lockfile, so an excluded dependency keeps its base version and so
  // does everything it pulls in (re-resolving from the head lockfile would keep a transitive
  // dependency at the newer version the old range still allows). Each kept update is pinned to
  // the exact version Dependabot locked, then its range is put back: the locked version satisfies
  // it, so it stays.
  await $`git show ${base}:pnpm-lock.yaml > pnpm-lock.yaml`;
  const restore: Array<{ path: string; name: string; ranges: Map<DepField, string> }> = [];
  for (const importer of head.importers) {
    const path = manifestOf(importer);
    const manifest = await readManifest(path);
    const baseText = await $`git show ${base}:${path}`.nothrow().quiet();
    const baseManifest: Manifest = baseText.exitCode === 0 ? JSON.parse(baseText.text()) : {};
    let dirty = false;
    for (const name of updated) {
      const key = `${importer}\0${name}`;
      const headRanges = rangesIn(manifest, name);
      if (excluded.includes(name)) {
        const baseRanges = rangesIn(baseManifest, name);
        if (JSON.stringify([...baseRanges]) === JSON.stringify([...headRanges])) continue;
        setRanges(manifest, name, baseRanges);
        dirty = true;
        continue;
      }
      const version = headLocked.get(key);
      if (version === undefined || version === baseLocked.get(key)) continue;
      setRanges(manifest, name, new Map([...headRanges].map(([field]) => [field, version])));
      restore.push({ path, name, ranges: headRanges });
      dirty = true;
    }
    if (dirty) await writeManifest(path, manifest);
  }
  await lockfileOnlyInstall();

  for (const { path, name, ranges } of restore) {
    const manifest = await readManifest(path);
    setRanges(manifest, name, ranges);
    await writeManifest(path, manifest);
  }
  await lockfileOnlyInstall();

  const result = parseLockfile(await Bun.file("pnpm-lock.yaml").text());
  const problems: string[] = [];
  // Resolving again could pick a version newer than either lockfile has, which nothing tested.
  for (const pkg of result.packages) {
    if (!baseLockfile.packages.has(pkg) && !head.packages.has(pkg)) {
      problems.push(`${pkg} is in neither the base nor the PR's lockfile`);
    }
  }
  for (const [key, version] of result.direct) {
    const [importer, name] = key.split("\0");
    if (name === undefined || !updated.includes(name)) continue;
    const expected = excluded.includes(name) ? baseLocked.get(key) : headLocked.get(key);
    if (expected !== undefined && expected !== version) {
      problems.push(`${importer}: ${name} resolved to ${version}, expected ${expected}`);
    }
  }
  if (problems.length > 0) throw new Error(`lockfile does not match:\n${problems.join("\n")}`);
}

if (import.meta.main) await main(Bun.argv.slice(2));
