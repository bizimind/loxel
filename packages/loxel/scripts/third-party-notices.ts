/**
 * Generates a product's third-party notices file at build time:
 *
 *   bun third-party-notices.ts <package-dir> <out-file>
 *
 * The file holds, sorted so the same install always gives the same bytes:
 *
 * - The Bun runtime, since every product is a `bun build --compile` binary.
 * - Entries from the package's optional third-party.json, for what has no package manager behind
 *   it: { "languageServers"?: "<dir of manifests>", "entries"?: [entry...] }
 * - The npm packages that ship: the package's `dependencies` closure, through workspace packages,
 *   plus each entry's `npm` packages (language servers built from a dev dependency).
 *
 * An entry, in third-party.json or as a language server manifest (named after its file):
 *
 *   { "name": "x", "license": "<SPDX id>", "source": "<URL>", "note"?: "...",
 *     "licenseFile": "<path>" | "npm": ["<package>"] }
 *
 * `licenseFile` is relative to the file holding the entry. A language server whose script pins
 * `const VERSION` must name that version in `source`, so a bump cannot leave a stale source link.
 */

import { existsSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");

/** Licenses that require telling recipients where to get the source. */
const SOURCE_NOTICE_LICENSES = /\b(MPL|EPL|LGPL)-/;

const LICENSE_FILE =
  /^(licen[cs]e|copying|notice|copyright|unlicense|third[-_ ]?party[-_ ]?notices?)([-_.][^/]*)?$/i;
const NOT_LICENSE_TEXT = /\.(js|cjs|mjs|ts|tsx|map|json|html|css|svg|png)$/i;

export interface NoticeEntry {
  name: string;
  license: string;
  source: string;
  note?: string;
  /** Absolute path of the license text. */
  licenseFile?: string;
  npm?: string[];
}

export interface NpmPackage {
  name: string;
  version: string;
  license: string;
  source?: string;
  /** Contents of the package's top-level license and notice files. */
  texts: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function optionalString(value: unknown, where: string, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${where}: ${field} must be a string`);
  return value;
}

/** Validates one entry; `baseDir` is what its `licenseFile` is relative to. */
export function parseEntry(raw: unknown, baseDir: string, where: string): NoticeEntry {
  if (!isRecord(raw)) throw new Error(`${where}: not an object`);
  const { name, license, source, note, licenseFile, npm } = raw;
  if (typeof name !== "string" || typeof license !== "string" || typeof source !== "string") {
    throw new Error(`${where}: third-party notices need license (SPDX id) and source (URL)`);
  }
  if (npm !== undefined && !(Array.isArray(npm) && npm.every((p) => typeof p === "string"))) {
    throw new Error(`${where}: npm must be a list of package names`);
  }
  const licenseFileName = optionalString(licenseFile, where, "licenseFile");
  if (licenseFileName === undefined && npm === undefined) {
    throw new Error(`${where}: third-party notices need licenseFile or npm`);
  }
  const licensePath =
    licenseFileName === undefined ? undefined : path.resolve(baseDir, licenseFileName);
  if (licensePath !== undefined && !existsSync(licensePath)) {
    throw new Error(`${where}: missing license file ${licenseFileName}`);
  }
  return {
    name,
    license,
    source,
    note: optionalString(note, where, "note"),
    licenseFile: licensePath,
    npm,
  };
}

async function readLanguageServerEntry(dir: string, file: string): Promise<NoticeEntry> {
  const raw: unknown = await Bun.file(path.join(dir, file)).json();
  if (!isRecord(raw)) throw new Error(`${file}: not an object`);
  const entry = parseEntry({ ...raw, name: path.basename(file, ".json") }, dir, file);
  if (typeof raw.script !== "string") throw new Error(`${file}: missing script`);
  const script = await Bun.file(path.join(dir, "..", raw.script)).text();
  const pinned = /const VERSION = "([^"]+)"/.exec(script)?.[1];
  if (pinned !== undefined && !entry.source.includes(pinned)) {
    throw new Error(`${file}: source must name the version ${raw.script} pins (${pinned})`);
  }
  return entry;
}

/** The entries a package declares, hand-maintained and language servers, in name order. */
export async function readEntries(packageDir: string): Promise<NoticeEntry[]> {
  const configPath = path.join(packageDir, "third-party.json");
  if (!existsSync(configPath)) return [];
  const config: unknown = await Bun.file(configPath).json();
  if (!isRecord(config)) throw new Error(`${configPath}: not an object`);
  const raws = Array.isArray(config.entries) ? config.entries : [];
  const entries = raws.map((raw) => parseEntry(raw, packageDir, "third-party.json"));
  if (typeof config.languageServers === "string") {
    const dir = path.resolve(packageDir, config.languageServers);
    const files = readdirSync(dir).filter((file) => file.endsWith(".json"));
    entries.push(...(await Promise.all(files.map((file) => readLanguageServerEntry(dir, file)))));
  }
  return entries.toSorted((a, b) => a.name.localeCompare(b.name, "en"));
}

/** Node's resolution, which pnpm's layout relies on: the nearest node_modules/<name>, real path. */
function resolvePackageDir(name: string, fromDir: string): string | undefined {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", name);
    if (existsSync(path.join(candidate, "package.json"))) return realpathSync(candidate);
    if (dir === path.dirname(dir)) return undefined;
  }
}

function dependencyNames(pkg: Record<string, unknown>): string[] {
  const keys = (value: unknown): string[] => (isRecord(value) ? Object.keys(value) : []);
  const optionalPeers = isRecord(pkg.peerDependenciesMeta) ? pkg.peerDependenciesMeta : {};
  return [
    ...keys(pkg.dependencies),
    ...keys(pkg.optionalDependencies),
    // A required peer is usually someone else's dependency too, but pnpm can auto-install it.
    ...keys(pkg.peerDependencies).filter((peer) => !(peer in optionalPeers)),
  ];
}

function declaredLicense(pkg: Record<string, unknown>): string {
  const { license, licenses } = pkg;
  if (typeof license === "string") return license;
  if (isRecord(license) && typeof license.type === "string") return license.type;
  if (Array.isArray(licenses)) {
    const types = licenses.flatMap((item) =>
      isRecord(item) && typeof item.type === "string" ? [item.type] : [],
    );
    if (types.length > 0) return types.join(" OR ");
  }
  return "not declared, see the license text";
}

function declaredSource(pkg: Record<string, unknown>): string | undefined {
  const { repository, homepage } = pkg;
  if (typeof homepage === "string") return homepage;
  if (typeof repository === "string") return repository;
  if (isRecord(repository) && typeof repository.url === "string") return repository.url;
  return undefined;
}

/** Vendored code keeps its license in a subdirectory, as victory-vendor does for d3. */
async function readLicenseTexts(dir: string): Promise<string[]> {
  const files = readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((file) => !file.split(path.sep).includes("node_modules"))
    .filter((file) => LICENSE_FILE.test(path.basename(file)))
    .filter((file) => !NOT_LICENSE_TEXT.test(file))
    .filter((file) => statSync(path.join(dir, file)).isFile())
    .toSorted();
  return Promise.all(
    files.map(async (file) => {
      const text = (await Bun.file(path.join(dir, file)).text()).replaceAll("\r\n", "\n").trim();
      return file.includes(path.sep) ? `${file.replaceAll(path.sep, "/")}:\n\n${text}` : text;
    }),
  );
}

/**
 * The closure of `packageDir`'s dependencies and of `extra` (resolved from `packageDir`). Workspace
 * packages are walked but not listed: they are this repo's own code.
 */
export async function collectNpmPackages(
  packageDir: string,
  extra: string[],
): Promise<NpmPackage[]> {
  const visited = new Set<string>();
  const found = new Map<string, NpmPackage>();

  async function visit(dir: string): Promise<void> {
    if (visited.has(dir)) return;
    visited.add(dir);
    const pkg: unknown = await Bun.file(path.join(dir, "package.json")).json();
    if (!isRecord(pkg)) throw new Error(`${dir}/package.json: not an object`);
    // A name may not resolve: a platform's optional package, or one removed by a pnpm override.
    for (const name of dependencyNames(pkg)) {
      const resolved = resolvePackageDir(name, dir);
      if (resolved !== undefined) await visit(resolved);
    }
    if (!dir.includes(`${path.sep}node_modules${path.sep}`)) return;
    const name = String(pkg.name);
    const version = String(pkg.version);
    found.set(`${name}@${version}`, {
      name,
      version,
      license: declaredLicense(pkg),
      source: declaredSource(pkg),
      texts: await readLicenseTexts(dir),
    });
  }

  const rootDir = realpathSync(packageDir);
  await visit(rootDir);
  for (const name of extra) {
    const resolved = resolvePackageDir(name, rootDir);
    if (resolved === undefined) throw new Error(`${name} is not installed`);
    await visit(resolved);
  }
  return [...found.values()].toSorted((a, b) =>
    `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`, "en"),
  );
}

const RULE = "=".repeat(80);

async function renderEntry(entry: NoticeEntry): Promise<string> {
  const lines = [RULE, entry.name, `License: ${entry.license}`, `Source: ${entry.source}`];
  if (SOURCE_NOTICE_LICENSES.test(entry.license)) {
    lines.push(`The source code of this program is available at the Source address above.`);
  }
  if (entry.note !== undefined) lines.push(entry.note);
  lines.push("");
  if (entry.licenseFile === undefined) {
    lines.push(`License text: see ${entry.npm?.join(", ")} under npm packages below.`);
  } else {
    lines.push((await Bun.file(entry.licenseFile).text()).replaceAll("\r\n", "\n").trim());
  }
  return lines.join("\n");
}

/** Packages sharing one license text are listed together, which monorepos make common. */
function renderNpmPackages(packages: NpmPackage[]): string {
  const groups = new Map<string, NpmPackage[]>();
  for (const pkg of packages) {
    const text =
      pkg.texts.length > 0
        ? pkg.texts.join("\n\n")
        : `This package includes no license file. It declares the license: ${pkg.license}`;
    groups.set(text, [...(groups.get(text) ?? []), pkg]);
  }
  return [...groups.entries()]
    .map(([text, group]) => {
      const heads = group.map(
        (pkg) => `${pkg.name}@${pkg.version} (${pkg.license})${pkg.source ? ` ${pkg.source}` : ""}`,
      );
      return [RULE, ...heads, "", text].join("\n");
    })
    .join("\n\n");
}

/** Renders the whole notices file. */
export async function renderNotices(
  packageDir: string,
  entries: NoticeEntry[],
  npmPackages: NpmPackage[],
): Promise<string> {
  const product = path.basename(path.resolve(packageDir));
  const sections = [
    `Third-party notices for ${product}. This software includes the components below, each under its own license.`,
    ...(await Promise.all(entries.map(renderEntry))),
    `${RULE}\nnpm packages\n`,
    renderNpmPackages(npmPackages),
  ];
  return `${sections.join("\n\n")}\n`;
}

/** Names an entry's npm packages as the notices list them: an alias resolves to another name. */
async function withInstalledNames(entry: NoticeEntry, packageDir: string): Promise<NoticeEntry> {
  if (entry.npm === undefined) return entry;
  const rootDir = realpathSync(packageDir);
  const npm = await Promise.all(
    entry.npm.map(async (name) => {
      const dir = resolvePackageDir(name, rootDir);
      if (dir === undefined) throw new Error(`${name} is not installed`);
      const pkg: unknown = await Bun.file(path.join(dir, "package.json")).json();
      if (!isRecord(pkg)) throw new Error(`${dir}/package.json: not an object`);
      return `${String(pkg.name)}@${String(pkg.version)}`;
    }),
  );
  return { ...entry, npm };
}

async function bunRuntimeEntry(): Promise<NoticeEntry> {
  const version = (await Bun.file(path.join(REPO_ROOT, ".bun-version")).text()).trim();
  return {
    name: `Bun runtime ${version}`,
    license: "MIT, statically linking LGPL-2.0 JavaScriptCore/WebKit (see below)",
    source: `https://github.com/oven-sh/bun/tree/bun-v${version}`,
    note: "Patched WebKit source: https://github.com/oven-sh/webkit",
    licenseFile: path.join(import.meta.dir, "third-party", "bun-LICENSE.md"),
  };
}

async function main(packageDir: string, outFile: string): Promise<void> {
  const entries = await readEntries(packageDir);
  const npmPackages = await collectNpmPackages(
    packageDir,
    entries.flatMap((entry) => entry.npm ?? []),
  );
  const notices = await renderNotices(
    packageDir,
    [
      await bunRuntimeEntry(),
      ...(await Promise.all(entries.map((entry) => withInstalledNames(entry, packageDir)))),
    ],
    npmPackages,
  );
  mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  await Bun.write(outFile, notices);
  console.log(`${outFile}: ${entries.length + 1} entries, ${npmPackages.length} npm packages`);
}

if (import.meta.main) {
  const [packageDir, outFile] = Bun.argv.slice(2);
  if (packageDir === undefined || outFile === undefined) {
    throw new Error("Usage: third-party-notices.ts <package-dir> <out-file>");
  }
  await main(packageDir, outFile);
}
