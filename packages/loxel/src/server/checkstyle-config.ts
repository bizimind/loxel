/**
 * Finding the Checkstyle setup that governs a Java file. Checkstyle has no discovery of its own, and
 * real projects keep its config anywhere, so the build says: `maven-checkstyle-plugin` in a `pom.xml`,
 * or Gradle's `checkstyle` plugin. Builds are only read as text, since running one would run the
 * repository's code. A config file no build names does not count, so a project that doesn't run
 * Checkstyle doesn't get it.
 */
import { readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

import { isRecord } from "@/lib/is-record";

import { readConfigFile } from "./config-file-read";
import { blockBodies, buildScripts, declaresPlugin, readCode } from "./kotlin-formatter";
import { dirsUpToRoot } from "./language-formatter";
import { isInside } from "./shipped-by-repo";
import { readToml, recordAt } from "./toml-file";
import { withoutXmlComments } from "./xml-comments";

const PLUGIN_ID = "checkstyle";
const MAVEN_PLUGIN = "maven-checkstyle-plugin";
/** Configs inside Checkstyle's own jar; `-c` takes these names with a leading slash. */
const BUNDLED_CONFIGS = new Set(["google_checks.xml", "sun_checks.xml"]);
const DEFAULT_MAVEN_CONFIG = "sun_checks.xml";
const DEFAULT_SUPPRESSIONS_PROPERTY = "checkstyle.suppressions.file";
/** Generated code, whichever source set a build adds it to. */
const OUTPUT_DIRS = new Set(["build", "target"]);
const MAX_PROPERTY_DEPTH = 8;
/** Where looking through a build's own plugins stops: they are few files. */
const MAX_CONVENTION_ENTRIES = 2000;
/** Where a Gradle build keeps plugins of its own, relative to its root. */
const CONVENTION_DIRS = ["buildSrc", "build-logic", "gradle/plugins", "gradle/build-logic"];
const CONVENTION_FILE = /\.(gradle|gradle\.kts|kts|java|kt|groovy)$/;
/** These build the plugins, which may check themselves differently. */
const BUILD_OF_PLUGINS = /^(build|settings)\.gradle(\.kts)?$/;

/** Which config a project names. */
export type CheckstyleConfigFile =
  | { kind: "file"; path: string }
  | { kind: "bundled"; name: string }
  /** It names one this machine can't reach as text: a URL, or a resource in a plugin's dependency. */
  | { kind: "not-found"; location: string };

/** Which files a project's build checks. */
interface CheckstyleScope {
  /** Directories whose files it checks, absolute; null for all of the project's but test ones. */
  sourceDirs: string[] | null;
  /** Test directories, absolute, that it leaves out or checks by `includeTests`. */
  testDirs: string[];
  includeTests: boolean;
  /** Globs relative to a source directory; empty includes every file. */
  includes: string[];
  excludes: string[];
}

export interface CheckstyleProject {
  /** The directory of the build file, which relative paths are read against. */
  dir: string;
  /** The topmost directory the build reaches, where shared files sit. */
  rootDir: string;
  /** The build file that declares Checkstyle. */
  buildFile: string;
  config: CheckstyleConfigFile;
  /** What the build gives the config for `${...}`, with no `${...}` left in a value. */
  properties: Record<string, string>;
  /** The Checkstyle version the build pins, when it says so in a way text can show. */
  pinnedVersion: string | null;
  scope: CheckstyleScope;
}

/**
 * The Checkstyle setup of each file asked about, read once until {@link clear}, so a save reads
 * nothing: which build files changed is what the manager hears about.
 */
export class CheckstyleDiscovery {
  private readonly byDir = new Map<string, CheckstyleProject | null>();

  constructor(private readonly wtPath: string) {}

  /** The project governing `file`, or null when no build runs Checkstyle on files there. */
  projectFor(file: string): CheckstyleProject | null {
    const dir = path.dirname(file);
    let project = this.byDir.get(dir);
    if (project === undefined) {
      project = findCheckstyleProject(dir, this.wtPath);
      this.byDir.set(dir, project);
    }
    return project && isInScope(project, file) ? project : null;
  }

  clear(): void {
    this.byDir.clear();
  }
}

/** Whether a change to `file` may change what discovery answers, or what a config reads. */
export function mayAffectCheckstyle(file: string): boolean {
  return (
    /\.(xml|gradle|kts|toml|properties)$/.test(file) || /\/(buildSrc|build-logic)\//.test(file)
  );
}

/** The setup of files directly in `dir`: the nearest build file that says anything about it. */
export function findCheckstyleProject(dir: string, wtPath: string): CheckstyleProject | null {
  const dirs = dirsUpToRoot(dir, wtPath);
  for (const [i, candidate] of dirs.entries()) {
    if (isFileAt(path.join(candidate, "pom.xml"))) return mavenProject(dirs.slice(i));
    if (buildScripts(candidate).some(Boolean)) return gradleProject(dirs.slice(i), wtPath);
  }
  return null;
}

function isInScope({ dir, scope }: CheckstyleProject, file: string): boolean {
  const parts = path.relative(dir, file).split(path.sep);
  // Not a package of that name, which sits below `src`.
  const srcAt = parts.indexOf("src");
  const above = srcAt === -1 ? parts : parts.slice(0, srcAt);
  if (above.some((part) => OUTPUT_DIRS.has(part))) return false;
  const under = (root: string) => file.startsWith(root + path.sep);
  const inTests = scope.testDirs.find(under);
  if (inTests && !scope.includeTests) return false;
  const base = inTests ?? scope.sourceDirs?.find(under) ?? (scope.sourceDirs ? null : dir);
  if (!base) return false;
  const relative = path.relative(base, file);
  const matches = (glob: string) =>
    new Bun.Glob(glob).match(relative) || new Bun.Glob(`**/${glob}`).match(relative);
  if (scope.excludes.some(matches)) return false;
  return scope.includes.length === 0 || scope.includes.some(matches);
}

// ---------------------------------------------------------------------------
// Maven

interface PomFile {
  dir: string;
  file: string;
  /** With its comments removed. */
  xml: string;
  /** Without its profiles, which are not always active. */
  main: string;
}

function mavenProject(dirs: readonly string[]): CheckstyleProject | null {
  const [dir] = dirs;
  if (!dir) return null;
  const chain = pomChain(dirs);
  const blocks = chain.flatMap(pluginBlocks);
  // Applied, or managed with a config, which a build's `checkstyle:check` goal runs.
  const declaring =
    chain.find((pom) => appliedPluginBlocks(pom).length > 0) ??
    chain.find((pom) => pluginBlocks(pom).some((block) => xmlText(block, "configLocation")));
  if (!declaring) return null;
  const rootDir = chain.at(-1)?.dir ?? dir;
  const properties = pomProperties(chain, dir);
  const expand = (value: string) => expandProperties(value, properties);
  const parameter = (name: string, property?: string): string | undefined => {
    for (const block of blocks) {
      const value = xmlText(block, name);
      if (value !== undefined) return expand(value);
    }
    return property === undefined ? undefined : properties[property];
  };
  // A profile that skips it, such as one for a fast build, says nothing about a usual one.
  const usual = chain.flatMap(mainPluginBlocks);
  const skip = usual.map((block) => xmlText(block, "skip")).find((value) => value !== undefined);
  if (expand(skip ?? properties["checkstyle.skip"] ?? "") === "true") return null;
  const locate = (location: string) => locateInBuild(location, chain, dirs.at(-1) ?? dir);
  const locations = blocks.flatMap((block) =>
    xmlTexts(block, "configLocation").map((location) => expand(location)),
  );
  const configProperty = properties["checkstyle.config.location"];
  const candidates = [...locations, ...(configProperty ? [configProperty] : [])];
  const config = pickConfig(candidates.length > 0 ? candidates : [DEFAULT_MAVEN_CONFIG], locate);
  return {
    dir,
    rootDir,
    buildFile: declaring.file,
    config,
    properties: mavenConfigProperties(properties, parameter, expand, locate),
    pinnedVersion: pomCheckstyleVersion(blocks, expand),
    scope: mavenScope(dir, chain, parameter, expand),
  };
}

/** The pom in the first of `dirs` that has one, and the parents it names that are above it. */
function pomChain(dirs: readonly string[]): PomFile[] {
  const chain: PomFile[] = [];
  const [start] = dirs;
  let current = start ? readPom(start) : null;
  // A pom can name itself or a child as its parent.
  while (current && !chain.some((pom) => pom.dir === current?.dir)) {
    chain.push(current);
    current = parentPom(current, dirs);
  }
  return chain;
}

function parentPom(pom: PomFile, dirs: readonly string[]): PomFile | null {
  const parent = xmlBlocks(pom.main, "parent")[0];
  if (parent === undefined) return null;
  const relative = xmlText(parent, "relativePath");
  // An empty one says the parent comes from a repository.
  if (relative === "") return null;
  const target = path.resolve(pom.dir, relative ?? "..");
  const dir = target.endsWith(".xml") ? path.dirname(target) : target;
  const top = dirs.at(-1);
  // Often a sibling of a parent directory, so anywhere in the worktree.
  const found = top && (dir === top || dir.startsWith(top + path.sep)) ? readPom(dir) : null;
  if (!found) return null;
  const artifact = xmlText(parent, "artifactId");
  // A pom above that isn't the one it names, such as a parent from a repository.
  return artifact === undefined || artifact === ownArtifactId(found) ? found : null;
}

function readPom(dir: string): PomFile | null {
  const file = path.join(dir, "pom.xml");
  const text = readConfigFile(file);
  if (text === undefined) return null;
  const xml = withoutXmlComments(text);
  return { dir, file, xml, main: removeBlocks(xml, "profiles") };
}

function ownArtifactId(pom: PomFile): string | undefined {
  return xmlText(removeBlocks(pom.main, "parent"), "artifactId");
}

/** The pom's plugin blocks for Checkstyle, the ones that say most about a usual build first. */
function pluginBlocks(pom: PomFile): string[] {
  return [...mainPluginBlocks(pom), ...xmlBlocks(pom.xml, "profiles").flatMap(checkstylePlugins)];
}

function mainPluginBlocks(pom: PomFile): string[] {
  const managed = xmlBlocks(pom.main, "pluginManagement").flatMap(checkstylePlugins);
  return [...checkstylePlugins(removeBlocks(pom.main, "pluginManagement")), ...managed];
}

/** Those that make it run, rather than say how it would: in the build, its reports or a profile. */
function appliedPluginBlocks(pom: PomFile): string[] {
  const applied = checkstylePlugins(removeBlocks(pom.main, "pluginManagement"));
  return [...applied, ...xmlBlocks(pom.xml, "profiles").flatMap(checkstylePlugins)];
}

function checkstylePlugins(xml: string): string[] {
  return xmlBlocks(xml, "plugin").filter((block) => xmlText(block, "artifactId") === MAVEN_PLUGIN);
}

function pomCheckstyleVersion(
  blocks: readonly string[],
  expand: (value: string) => string,
): string | null {
  for (const block of blocks) {
    for (const dependency of xmlBlocks(block, "dependency")) {
      if (xmlText(dependency, "groupId") !== "com.puppycrawl.tools") continue;
      const version = expand(xmlText(dependency, "version") ?? "");
      if (version && !version.includes("${")) return version;
    }
  }
  return null;
}

/** The `<properties>` of the chain, a child's over its parents', and the directories Maven names. */
function pomProperties(chain: readonly PomFile[], dir: string): Record<string, string> {
  const properties: Record<string, string> = {};
  const rootDir = chain.at(-1)?.dir ?? dir;
  for (const pom of chain.toReversed()) {
    for (const section of xmlBlocks(pom.main, "properties")) {
      for (const [, name, value] of section.matchAll(/<([\w.-]+)>([^<]*)<\/\1>/g)) {
        if (name) properties[name] = value?.trim() ?? "";
      }
    }
  }
  return {
    ...properties,
    basedir: dir,
    "project.basedir": dir,
    "pom.basedir": dir,
    "maven.multiModuleProjectDirectory": rootDir,
    "session.executionRootDirectory": rootDir,
    ...(chain[1] ? { "project.parent.basedir": chain[1].dir } : {}),
  };
}

/** What `maven-checkstyle-plugin` hands the config, as its executor does. */
function mavenConfigProperties(
  properties: Record<string, string>,
  parameter: (name: string, property?: string) => string | undefined,
  expand: (value: string) => string,
  locate: (location: string) => string | null,
): Record<string, string> {
  const result: Record<string, string> = { ...properties };
  const propertiesLocation = parameter("propertiesLocation", "checkstyle.properties.location");
  if (propertiesLocation) {
    const file = locate(propertiesLocation);
    if (file) Object.assign(result, parsePropertiesText(readConfigFile(file) ?? ""));
  }
  const expansion = parameter("propertyExpansion");
  if (expansion) Object.assign(result, parsePropertiesText(expansion));
  const suppressions = parameter("suppressionsLocation", "checkstyle.suppressions.location");
  const suppressionsFile = suppressions ? locate(suppressions) : null;
  if (suppressionsFile) {
    const name = parameter("suppressionsFileExpression") ?? DEFAULT_SUPPRESSIONS_PROPERTY;
    result[name] = suppressionsFile;
  }
  const header = parameter("headerLocation", "checkstyle.header.file") ?? "LICENSE.txt";
  const headerFile = locate(header);
  if (headerFile) result["checkstyle.header.file"] = headerFile;
  return cleanProperties(result, expand);
}

/** The first location there's a file for, else the first; a bundled name counts as found. */
function pickConfig(
  locations: readonly string[],
  locate: (location: string) => string | null,
): CheckstyleConfigFile {
  let notFound: CheckstyleConfigFile | null = null;
  for (const location of locations) {
    const bundled = location.replace(/^(classpath:)?\/?/, "");
    if (BUNDLED_CONFIGS.has(bundled)) return { kind: "bundled", name: bundled };
    const file = locate(location);
    if (file) return { kind: "file", path: file };
    notFound ??= { kind: "not-found", location };
  }
  return notFound ?? { kind: "not-found", location: "" };
}

/**
 * The file a Maven location names, without fetching a URL. It may be relative to any pom of the
 * chain, or a resource of a sibling module its plugin depends on.
 */
function locateInBuild(location: string, chain: readonly PomFile[], wtPath: string): string | null {
  if (!location || location.includes("://") || location.includes("${")) return null;
  const inside = location.replace(/^(classpath:)?\/+/, "");
  const roots = chain.map((pom) => pom.dir);
  const topDir = roots.at(-1);
  const candidates = [
    ...(path.isAbsolute(location) ? [location] : []),
    ...roots.map((root) => path.join(root, inside)),
    ...(topDir ? listDir(topDir) : []).map((entry) =>
      path.join(topDir ?? "", entry, "src", "main", "resources", inside),
    ),
  ];
  return candidates.find((file) => isFileInWorktree(file, wtPath)) ?? null;
}

/** By real paths, so a link in the repository doesn't reach what's outside it. */
function isFileInWorktree(file: string, wtPath: string): boolean {
  try {
    return isFileAt(file) && isInside(realpathSync(file), realpathSync(wtPath));
  } catch {
    return false;
  }
}

function mavenScope(
  dir: string,
  chain: readonly PomFile[],
  parameter: (name: string, property?: string) => string | undefined,
  expand: (value: string) => string,
): CheckstyleScope {
  const absolute = (value: string) => path.resolve(dir, expand(value));
  const declared = chain[0]?.main ?? "";
  const build = xmlBlocks(declared, "build")[0] ?? "";
  const sourceDirectories = chain
    .flatMap(pluginBlocks)
    .flatMap((block) => xmlBlocks(block, "sourceDirectories"))[0];
  const sourceDirs = (
    sourceDirectories
      ? xmlTexts(sourceDirectories, "sourceDirectory").map(absolute)
      : [absolute(xmlText(build, "sourceDirectory") ?? "src/main/java")]
  ).filter((source) => !source.includes("${"));
  const testDir = absolute(xmlText(build, "testSourceDirectory") ?? "src/test/java");
  return {
    // None that text can show leaves `includes` to pick from the whole project.
    sourceDirs: sourceDirs.length > 0 ? sourceDirs : null,
    testDirs: [testDir],
    includeTests:
      parameter("includeTestSourceDirectory", "checkstyle.includeTestSourceDirectory") === "true",
    includes: commaList(parameter("includes", "checkstyle.includes")),
    excludes: commaList(parameter("excludes", "checkstyle.excludes")),
  };
}

function commaList(value: string | undefined): string[] {
  if (!value || value.includes("${")) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** The text of the first `<name>` element, or undefined when there is none. */
function xmlText(xml: string, name: string): string | undefined {
  return xmlTexts(xml, name)[0];
}

function xmlTexts(xml: string, name: string): string[] {
  return [...xml.matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([^<]*)</${name}>`, "g"))].map(
    ([, value]) => (value ?? "").trim(),
  );
}

/** The inside of each outermost `<name>` element. */
function xmlBlocks(xml: string, name: string): string[] {
  return blockRanges(xml, name).map(({ start, end }) => xml.slice(start, end));
}

function removeBlocks(xml: string, name: string): string {
  let result = "";
  let from = 0;
  for (const { outerStart, outerEnd } of blockRanges(xml, name)) {
    result += xml.slice(from, outerStart);
    from = outerEnd;
  }
  return result + xml.slice(from);
}

function blockRanges(
  xml: string,
  name: string,
): { start: number; end: number; outerStart: number; outerEnd: number }[] {
  const ranges: { start: number; end: number; outerStart: number; outerEnd: number }[] = [];
  const tags = new RegExp(`<(/?)${name}(?:\\s[^>]*)?(/?)>`, "g");
  let depth = 0;
  let outerStart = 0;
  let start = 0;
  for (const match of xml.matchAll(tags)) {
    if (match[2]) continue;
    if (match[1]) {
      depth = Math.max(0, depth - 1);
      if (depth === 0) {
        const outerEnd = match.index + match[0].length;
        ranges.push({ start, end: match.index, outerStart, outerEnd });
      }
    } else {
      if (depth === 0) {
        outerStart = match.index;
        start = match.index + match[0].length;
      }
      depth += 1;
    }
  }
  return ranges;
}

// ---------------------------------------------------------------------------
// Gradle

function gradleProject(dirs: readonly string[], wtPath: string): CheckstyleProject | null {
  const [dir] = dirs;
  if (!dir) return null;
  const rootDir = gradleRoot(dirs);
  const between = dirs.slice(0, dirs.indexOf(rootDir) + 1);
  const own = gradleScripts(dir);
  // A parent's script reaches here through its `subprojects` or `allprojects`, or from a plugin.
  const parents = between.slice(1).flatMap((parent) => gradleScripts(parent));
  const shared = [
    ...parents.flatMap((script) => blockBodies(script.text, SHARED_BLOCK)),
    ...appliedScripts([...own, ...parents], dir, rootDir).map((script) => script.text),
    ...conventionTexts(rootDir, wtPath),
  ];
  const texts = [...own.map((script) => script.text), ...shared];
  if (!texts.some(appliesPlugin)) return null;
  const buildFile = gradleBuildFile(dir, between);
  const paths = { projectDir: dir, rootDir };
  const settings = texts.flatMap(checkstyleSettings);
  const directory =
    firstPath(settings, CONFIG_DIRECTORY, paths) ?? path.join(rootDir, "config", PLUGIN_ID);
  const named = namedConfigs(settings);
  const file =
    firstPath(settings, CONFIG_FILE, paths) ??
    (named ? path.resolve(directory, named) : path.join(directory, "checkstyle.xml"));
  return {
    dir,
    rootDir,
    buildFile,
    config: isFileInWorktree(file, wtPath)
      ? { kind: "file", path: file }
      : { kind: "not-found", location: path.relative(wtPath, file) },
    properties: gradleProperties(settings, paths, directory),
    pinnedVersion: gradleToolVersion(firstMatch(settings, TOOL_VERSION), rootDir),
    scope: gradleScope(texts, dir),
  };
}

const SHARED_BLOCK = /\b(?:subprojects|allprojects|configure\s*\([^)]*\))\s*\{/g;
const CHECKSTYLE_EXTENSION = /(?:^|[\s(])checkstyle\s*\{/m;
const CONFIG_DIRECTORY =
  /\b(?:(?:get|set)?[cC]onfig(?:Dir|Directory))\b(?:\(\))?\s*(?:=|\.set\(|\()\s*(.+)/;
const CONFIG_FILE = /\b(?:(?:get|set)?[cC]onfigFile)\b(?:\(\))?\s*(?:=|\.set\(|\()\s*(.+)/;
/** `config = resources.text.fromFile(configDirectory.file("x.xml"))`, a config by another name. */
const CONFIG_RESOURCE = /\bfromFile\(.*?["']([\w./-]+\.xml)["']/g;
const TOOL_VERSION = /\b(?:[sS]et)?[tT]oolVersion\b\s*(?:=|\.set\(|\(|\s)\s*(.+)/;
const CONFIG_PROPERTIES = /\bconfigProperties\b\s*(?:=|\.putAll\(|\.set\()\s*/;
const CHECKSTYLE_TASK_BLOCK =
  /(?:\bwithType\s*\(?\s*(?:<\s*)?Checkstyle\b[^{]*|\bcheckstyle(?:Main|Test)\b[^{\n]*|\bnamed\s*\(?\s*["']checkstyle\w*["'][^{\n]*)\{/g;

/**
 * What a script says to Checkstyle: other tools have a `toolVersion` or `configFile` too. Its
 * extension's block, its tasks', and statements on the extension, as a plugin in Java writes them.
 */
function checkstyleSettings(text: string): string[] {
  return [
    ...blockBodies(text, /(?:^|[\s(.])checkstyle\s*\{/gm),
    ...blockBodies(text, /\bconfigure<CheckstyleExtension>\s*\{/g),
    ...blockBodies(text, CHECKSTYLE_TASK_BLOCK),
    ...(text.match(/\bcheckstyle\.\w[^\n]*/g) ?? []),
  ];
}

function appliesPlugin(text: string): boolean {
  return (
    declaresPlugin(text, PLUGIN_ID) ||
    /\bCheckstylePlugin\b/.test(text) ||
    /plugins\s*\{[^}]*(?:^|\s)`?checkstyle`?\s*(?:$|\s|})/m.test(text) ||
    CHECKSTYLE_EXTENSION.test(text)
  );
}

function gradleScripts(dir: string): { file: string; text: string }[] {
  return ["build.gradle.kts", "build.gradle"].flatMap((name) => {
    const file = path.join(dir, name);
    const text = readCode(file, name.endsWith(".kts") ? "kotlin" : "groovy");
    return text ? [{ file, text }] : [];
  });
}

/** The nearest directory with a settings file, or the topmost with a build script. */
function gradleRoot(dirs: readonly string[]): string {
  const withSettings = dirs.find(
    (dir) =>
      isFileAt(path.join(dir, "settings.gradle")) ||
      isFileAt(path.join(dir, "settings.gradle.kts")),
  );
  if (withSettings) return withSettings;
  const withScripts = dirs.filter((dir) => buildScripts(dir).some(Boolean));
  return withScripts.at(-1) ?? dirs[0] ?? "";
}

function gradleBuildFile(dir: string, between: readonly string[]): string {
  for (const candidate of between) {
    const script = gradleScripts(candidate).find((entry) => appliesPlugin(entry.text));
    if (script) return script.file;
  }
  return gradleScripts(dir)[0]?.file ?? path.join(dir, "build.gradle");
}

/** The scripts a build pulls in with `apply from:`, one level deep. */
function appliedScripts(
  scripts: readonly { file: string; text: string }[],
  dir: string,
  rootDir: string,
): { file: string; text: string }[] {
  const found: { file: string; text: string }[] = [];
  const pattern = /\b(?:apply\s*\(?\s*from\s*[:=]\s*|apply\s+from:\s*)["']([^"']+)["']/g;
  for (const { text, file: from } of scripts) {
    for (const [, target] of text.matchAll(pattern)) {
      if (!target || target.includes("://")) continue;
      const resolved = resolveGradleString(target, { projectDir: path.dirname(from), rootDir });
      const file = resolved && path.resolve(dir, resolved);
      if (!file || !file.startsWith(rootDir + path.sep) || !isFileAt(file)) continue;
      const contents = readCode(file, file.endsWith(".kts") ? "kotlin" : "groovy");
      if (contents) found.push({ file, text: contents });
    }
  }
  return found;
}

/** What the build's own plugins say about Checkstyle, each file only if it mentions it. */
function conventionTexts(rootDir: string, wtPath: string): string[] {
  if (!rootDir.startsWith(path.resolve(wtPath))) return [];
  const texts: string[] = [];
  const queue = CONVENTION_DIRS.map((dir) => path.join(rootDir, dir));
  let seen = 0;
  for (let i = 0; i < queue.length && seen < MAX_CONVENTION_ENTRIES; i++) {
    const dir = queue[i] ?? "";
    for (const entry of listDir(dir)) {
      seen += 1;
      if (entry.startsWith(".")) continue;
      if (OUTPUT_DIRS.has(entry) && !dir.includes(`${path.sep}src${path.sep}`)) continue;
      const child = path.join(dir, entry);
      if (isDirectoryAt(child)) {
        queue.push(child);
      } else if (CONVENTION_FILE.test(entry) && !BUILD_OF_PLUGINS.test(entry)) {
        const text = readConfigFile(child);
        if (text && /checkstyle/i.test(text)) texts.push(text);
      }
    }
  }
  return texts;
}

/** The config a build names through `resources.text`, the one for main code when it has several. */
function namedConfigs(texts: readonly string[]): string | undefined {
  const names = texts.flatMap((text) =>
    [...text.matchAll(CONFIG_RESOURCE)].flatMap(([, name]) => (name ? [name] : [])),
  );
  return names.find((name) => !/test|nohttp/i.test(name)) ?? names[0];
}

/** The first path an assignment `pattern` matches names in a way text can show. */
function firstPath(
  texts: readonly string[],
  pattern: RegExp,
  paths: GradlePaths,
): string | undefined {
  for (const text of texts) {
    const found = gradlePath(pattern.exec(text)?.[1], paths);
    if (found) return found;
  }
  return undefined;
}

function firstMatch(texts: readonly string[], pattern: RegExp): string | undefined {
  for (const text of texts) {
    const value = pattern.exec(text)?.[1];
    if (value) return value.trim();
  }
  return undefined;
}

interface GradlePaths {
  projectDir: string;
  rootDir: string;
}

/** The path an expression such as `file("$rootDir/x")` or `rootProject.file("x")` names. */
function gradlePath(expression: string | undefined, paths: GradlePaths): string | null {
  if (!expression) return null;
  const literal = /["']([^"']+)["']/.exec(expression)?.[1];
  if (!literal) return null;
  const resolved = resolveGradleString(literal, paths);
  if (!resolved) return null;
  const fromRoot = /\b(rootProject|rootDir|getRootProject|getRootDir|settingsDirectory)\b/.test(
    expression,
  );
  return path.resolve(fromRoot ? paths.rootDir : paths.projectDir, resolved);
}

/** A string with Gradle's directory variables filled in, or null when another variable is left. */
function resolveGradleString(value: string, { projectDir, rootDir }: GradlePaths): string | null {
  const resolved = value.replace(
    /\$\{?((?:rootProject\.|project\.)?(?:rootDir|projectDir|buildDir|config_loc)(?:\.\w+)?)\}?/g,
    (_, name: string) => {
      if (name.includes("buildDir")) return path.join(projectDir, "build");
      return name.includes("rootDir") || name.startsWith("rootProject") ? rootDir : projectDir;
    },
  );
  return resolved.includes("$") ? null : resolved;
}

function gradleProperties(
  texts: readonly string[],
  paths: GradlePaths,
  configDirectory: string,
): Record<string, string> {
  const result: Record<string, string> = {
    // The Ant task behind Gradle's Checkstyle hands over its project's own.
    basedir: paths.projectDir,
    config_loc: configDirectory,
  };
  for (const text of texts) {
    const start = CONFIG_PROPERTIES.exec(text);
    if (!start) continue;
    const body = text.slice(start.index + start[0].length);
    for (const [name, value] of mapEntries(body)) {
      const resolved = resolveGradleString(value, paths);
      if (resolved !== null && !(name in result)) result[name] = resolved;
    }
  }
  return result;
}

/** The entries of a map literal at the start of `text`: `['a': 'b', c: "d"]` or `mapOf("a" to "b")`. */
function mapEntries(text: string): [string, string][] {
  const open = /^\s*(?:mapOf\(|\[)/.exec(text);
  if (!open) return [];
  const close = text.indexOf(text.trimStart().startsWith("[") ? "]" : ")", open[0].length);
  if (close === -1) return [];
  const body = text.slice(open[0].length, close);
  const entries: [string, string][] = [];
  const entry =
    /["']?([\w.-]+)["']?\s*(?::|\bto\b)\s*(?:(?:rootProject\.|project\.)?file\(\s*)?["']([^"']*)["']/g;
  for (const [, name, value] of body.matchAll(entry)) {
    if (name && value !== undefined) entries.push([name, value]);
  }
  return entries;
}

/** A pinned version from a literal, `gradle.properties`, or the version catalog's `checkstyle`. */
function gradleToolVersion(expression: string | undefined, rootDir: string): string | null {
  const literal = /^["']?(\d[\w.-]*)["']?\)?\s*$/.exec(expression ?? "")?.[1];
  if (literal) return literal;
  if (!expression) return null;
  const quoted = /^["'](\d[\w.-]*)["']/.exec(expression)?.[1];
  if (quoted) return quoted;
  const name = /^["']?\$?\{?(?:project\.)?(\w+)\}?["']?\)?\s*$/.exec(expression)?.[1];
  if (name) {
    const properties = parsePropertiesText(
      readConfigFile(path.join(rootDir, "gradle.properties")) ?? "",
    );
    const fromProperties = properties[name];
    if (fromProperties) return fromProperties;
  }
  return catalogVersion(rootDir);
}

/** The version catalog's `checkstyle`, under `[versions]` or as a library's coordinate. */
function catalogVersion(rootDir: string): string | null {
  const catalog = readToml(path.join(rootDir, "gradle", "libs.versions.toml"));
  if (!catalog) return null;
  const version = recordAt(catalog, "versions")?.checkstyle;
  if (typeof version === "string") return version;
  const library = recordAt(catalog, "libraries")?.checkstyle;
  const coordinate = isRecord(library) ? library.version : library;
  if (typeof coordinate !== "string") return null;
  return coordinate.split(":").at(-1) ?? null;
}

function gradleScope(texts: readonly string[], dir: string): CheckstyleScope {
  const tasks = texts.flatMap((text) => blockBodies(text, CHECKSTYLE_TASK_BLOCK));
  const excludes = tasks.flatMap((task) =>
    [...task.matchAll(/\bexclude\s*\(?\s*["']([^"']+)["']/g)].flatMap(([, glob]) =>
      glob ? [glob] : [],
    ),
  );
  const includes = tasks.flatMap((task) =>
    [...task.matchAll(/\binclude\s*\(?\s*["']([^"']+)["']/g)].flatMap(([, glob]) =>
      glob ? [glob] : [],
    ),
  );
  return {
    sourceDirs: null,
    testDirs: [path.join(dir, "src", "test")],
    includeTests: !texts.some(leavesTestsOut),
    includes,
    excludes,
  };
}

/** `sourceSets = [sourceSets.main]`, or a disabled `checkstyleTest`. */
function leavesTestsOut(text: string): boolean {
  const sets = /\bsourceSets\s*=\s*(?:\[|listOf\()([^\])]*)/.exec(text)?.[1];
  if (sets !== undefined && !/\btest\b/.test(sets)) return true;
  if (/\bcheckstyleTest\.enabled\s*=\s*false\b/.test(text)) return true;
  return blockBodies(
    text,
    /\bcheckstyleTest\b[^{\n]*\{|named\s*\(?\s*["']checkstyleTest["'][^{\n]*\{/g,
  ).some((body) => /\benabled\s*=\s*false\b/.test(body));
}

// ---------------------------------------------------------------------------
// Properties

/** `${name}` filled in from `properties`; what is unknown stays as it is. */
function expandProperties(value: string, properties: Record<string, string>): string {
  let result = value;
  for (let depth = 0; depth < MAX_PROPERTY_DEPTH && result.includes("${"); depth++) {
    const next = result.replace(/\$\{([^}]+)\}/g, (whole, name: string) => {
      return properties[name] ?? whole;
    });
    if (next === result) break;
    result = next;
  }
  return result;
}

/** Every value expanded, without those still naming something unknown. */
function cleanProperties(
  properties: Record<string, string>,
  expand: (value: string) => string,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(properties)) {
    const expanded = expand(value);
    if (!expanded.includes("${")) result[name] = expanded;
  }
  return result;
}

/** The `key=value` lines of a properties file or a `propertyExpansion`. */
export function parsePropertiesText(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const entry = /^\s*([^#!\s][^=:\s]*)\s*[=:]\s*(.*?)\s*$/.exec(line);
    if (entry?.[1]) result[entry[1]] = entry[2] ?? "";
  }
  return result;
}

// ---------------------------------------------------------------------------

function isFileAt(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function isDirectoryAt(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
