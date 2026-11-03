import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";

import { isRecord } from "@/lib/is-record";

import { blockBodies, declaresPlugin, readCode, readText } from "./kotlin-formatter";
import { dirsUpToRoot, type FormatterDecline } from "./language-formatter";
import { buildSpawnEnv } from "./shell-env";
import { readToml, recordAt } from "./toml-file";

export const GOOGLE_JAVA_FORMAT = "google-java-format";
export const PALANTIR_JAVA_FORMAT = "palantir-java-format";
export type JavaFormatTool = typeof GOOGLE_JAVA_FORMAT | typeof PALANTIR_JAVA_FORMAT;

/** What a project's build files say about formatting its Java. */
export interface JavaFormatDeclaration {
  tool: JavaFormatTool;
  /** The version the build uses. */
  pin: string;
  /** The command-line flags matching the build's formatter settings. */
  flags: string[];
}

/** How a build names a version, before looking at the other files it may be in. */
type VersionRef =
  /** Spotless with no version picks one itself, by its own release and the JVM. */
  | { kind: "spotless-default" }
  /** The fmt plugin carries its own google-java-format, named by the plugin's published POM. */
  | { kind: "fmt-plugin"; group: string; pluginVersion: VersionRef }
  | { kind: "literal"; version: string }
  | { kind: "maven-property"; name: string }
  | { kind: "gradle-variable"; name: string; script: string }
  | { kind: "catalog-version"; alias: string }
  | { kind: "catalog-library"; alias: string }
  | { kind: "plugin"; script: string }
  | { kind: "unreadable" };

/** Which files a declaration formats, by glob relative to a project directory. */
type FileScope =
  /** It uses a form that cannot be read as text, so no file is known to be in it. */
  | "unreadable"
  | {
      /** Null covers every Java file, for Gradle's source sets, which text cannot show. */
      includes: string[] | null;
      excludes: string[];
      /** Whether it also applies from the directories of projects below the one declaring it. */
      inherited: boolean;
      /** Gradle leaves a project's own `build` directory out of everything. */
      excludeBuildDir: boolean;
    };

/** What one build file declares. */
type BuildSignal =
  | {
      kind: "formatter";
      tool: JavaFormatTool;
      version: VersionRef;
      flags: string[];
      scope: FileScope;
    }
  /** Its Java is formatted by something else or not at all, so a parent's declaration does not apply. */
  | { kind: "other" }
  /** A Maven plugin applied here with its configuration in a `pluginManagement`, here or above. */
  | { kind: "applied-elsewhere" }
  /** The fmt plugin's entry, which what `pluginManagement` entries above it say still adds to. */
  | { kind: "fmt-plugin"; plugin: string }
  /** Plugins applied through catalog aliases, which only the catalog can name. */
  | { kind: "plugin-aliases"; aliases: string[] }
  | FormatterDecline;

const BUILD_FILES = ["pom.xml", "build.gradle.kts", "build.gradle"];
const VERSION = /^\d+(?:\.\d+)+(?:[-.][\w.-]+)?$/;
const CATALOG = join("gradle", "libs.versions.toml");

const PALANTIR_PLUGIN = "com.palantir.java-format";
const PALANTIR_PLUGIN_COORDINATE = "com.palantir.javaformat:gradle-palantir-java-format";

const REFLOW = "--skip-reflowing-long-strings";
const SKIP_JAVADOC = "--skip-javadoc-formatting";
const SKIP_SORTING = "--skip-sorting-imports";
const SKIP_UNUSED = "--skip-removing-unused-imports";

const TOGGLE_NOTICE: FormatterDecline = {
  notice:
    "Format on save skipped: this project's Spotless config uses toggleOffOn, which the formatter's command can't apply. Run Spotless from your build instead.",
};
const FORK_NOTICE: FormatterDecline = {
  notice:
    "Format on save skipped: this project's Spotless config names its own formatter artifact, which Loxel can't match. Run Spotless from your build instead.",
};
const UNREADABLE_OPTION_NOTICE: FormatterDecline = {
  notice:
    "Format on save skipped: Loxel can't read this project's formatter options from its build files. Format from your build instead.",
};
const PALANTIR_JAVADOC_NOTICE: FormatterDecline = {
  notice:
    "Format on save skipped: this project formats Javadoc with palantir-java-format, which its command can't do. Run Spotless from your build instead.",
};

/**
 * The formatter declared for files under `startDir`, from the nearest build file that says anything
 * about it up to `wtRoot`. Only reads files as text: running a build to ask would run the
 * repository's code on save. A formatter configured where the text does not show it, in a convention
 * plugin or a parent POM that is not in a directory above, is not seen.
 *
 * A declaration whose version cannot be read declines, since no version could be shown to match. A
 * file the declaration leaves out, or may leave out, formats nothing: with `fileName` absent, as when
 * Settings lists a worktree's formatters, that is not checked.
 */
export function findJavaFormatDeclaration(
  startDir: string,
  wtRoot: string,
  fileName?: string,
): JavaFormatDeclaration | FormatterDecline | null {
  const dirs = dirsUpToRoot(startDir, wtRoot);
  let awaitingManaged = false;
  for (const [i, dir] of dirs.entries()) {
    const own = dirSignal(dir);
    awaitingManaged ||= hasKind(own, "applied-elsewhere");
    const found = awaitingManaged ? (managedSignal(dir) ?? own) : own;
    const signal = hasKind(found, "plugin-aliases")
      ? palantirByAlias(found.aliases, dirs.slice(i))
      : hasKind(found, "fmt-plugin")
        ? fmtMavenSignal([found.plugin, ...managedFmtPlugins(dirs.slice(i))])
        : found;
    if (
      !signal ||
      hasKind(signal, "applied-elsewhere") ||
      hasKind(signal, "plugin-aliases") ||
      hasKind(signal, "fmt-plugin")
    ) {
      continue;
    }
    if ("notice" in signal) return signal;
    if (signal.kind === "other") return null;
    if (fileName && !isInScope(signal.scope, join(startDir, fileName), dirs.slice(0, i + 1))) {
      return null;
    }
    if (signal.version.kind === "spotless-default") {
      return {
        notice: `Format on save skipped: Spotless chooses this project's ${signal.tool} version itself, so Loxel can't tell which it is. Name the version in your Spotless config to format on save.`,
      };
    }
    const pin = resolveVersion(signal.version, dirs.slice(i));
    if (pin === undefined) {
      return {
        notice: `Format on save skipped: Loxel can't determine which ${signal.tool} version this project uses from its build files.`,
      };
    }
    return { tool: signal.tool, pin, flags: signal.flags };
  }
  return null;
}

function hasKind<K extends string>(
  signal: BuildSignal | null,
  kind: K,
): signal is Extract<BuildSignal, { kind: K }> {
  return signal !== null && "kind" in signal && signal.kind === kind;
}

function managedSignal(dir: string): BuildSignal | null {
  return cachedByFile(join(dir, "pom.xml"), managedMavenSignal, "managed");
}

function dirSignal(dir: string): BuildSignal | null {
  return (
    cachedByFile(join(dir, "pom.xml"), appliedMavenSignal) ??
    cachedByFile(join(dir, "build.gradle.kts"), (path) => gradleSignal(readCode(path, "kotlin"))) ??
    cachedByFile(join(dir, "build.gradle"), (path) => gradleSignal(readCode(path, "groovy")))
  );
}

const signalCache = new Map<string, { fingerprint: bigint | number; signal: BuildSignal | null }>();
const MAX_CACHED_SIGNALS = 1_000;

/**
 * `parse(path)`, kept while the file's content stays. This runs on every save, when reading is cheap
 * and parsing less so. A size and mtime would miss a same-size edit within one clock tick.
 */
function cachedByFile(
  path: string,
  parse: (path: string) => BuildSignal | null,
  variant = "",
): BuildSignal | null {
  const text = readText(path);
  if (!text) return null;
  const fingerprint = Bun.hash(text);
  const key = `${path}\0${variant}`;
  const cached = signalCache.get(key);
  if (cached?.fingerprint === fingerprint) return cached.signal;
  const signal = parse(path);
  if (signalCache.size >= MAX_CACHED_SIGNALS) signalCache.clear();
  signalCache.set(key, { fingerprint, signal });
  return signal;
}

// ---------------------------------------------------------------------------
// Maven

const FMT_PLUGIN_GROUPS = new Set(["com.spotify.fmt", "com.spotify", "com.coveo"]);
const MAVEN_SOURCES = ["src/main/java/**/*.java", "src/test/java/**/*.java"];
/** Settings of the fmt plugin that change which files it covers. */
const FMT_SCOPE_SETTINGS = [
  "skip",
  "sourceDirectory",
  "testSourceDirectory",
  "additionalSourceDirectories",
  "filesNamePattern",
  "filesPathPattern",
  "skipSourceDirectory",
  "skipTestSourceDirectory",
];
const FMT_OPTIONS = [
  "style",
  "skipSortingImports",
  "skipRemovingUnusedImports",
  "skipReflowingLongStrings",
];
const MAVEN_OPTIONS = ["style", "reflowLongStrings", "reorderImports", "formatJavadoc"];
const OTHER_SPOTLESS_JAVA_ELEMENT = /<(eclipse|prettier|clangFormat|greclipse)\b/;

/** What the POM's applied plugins say. A `pluginManagement` entry alone applies to no module. */
function appliedMavenSignal(path: string): BuildSignal | null {
  const xml = readPom(path);
  let applied = "";
  let from = 0;
  for (const { start, end } of xmlBlocks(xml, "pluginManagement")) {
    applied += xml.slice(from, start);
    from = end;
  }
  return pluginsSignal(applied + xml.slice(from));
}

function managedMavenSignal(path: string): BuildSignal | null {
  const signals = xmlBlocks(readPom(path), "pluginManagement").map(({ body }) =>
    pluginsSignal(body),
  );
  return signals.find((signal) => signal && !hasKind(signal, "applied-elsewhere")) ?? null;
}

function readPom(path: string): string {
  const text = readText(path);
  return text.includes("-maven-plugin") || text.includes("<properties>")
    ? withoutXmlComments(text)
    : "";
}

function isFmtPlugin(plugin: string): boolean {
  return (
    xmlElement(plugin, "artifactId") === "fmt-maven-plugin" &&
    FMT_PLUGIN_GROUPS.has(xmlElement(plugin, "groupId") ?? "")
  );
}

/** The fmt plugin's `pluginManagement` entries from these directories, nearest first. */
function managedFmtPlugins(dirs: readonly string[]): string[] {
  return dirs.flatMap((dir) =>
    xmlBlocks(readPom(join(dir, "pom.xml")), "pluginManagement").flatMap(({ body }) =>
      xmlBlocks(body, "plugin")
        .map((plugin) => plugin.body)
        .filter(isFmtPlugin),
    ),
  );
}

function pluginsSignal(xml: string): BuildSignal | null {
  let applied: BuildSignal | null = null;
  for (const { body: plugin } of xmlBlocks(xml, "plugin")) {
    const artifact = xmlElement(plugin, "artifactId");
    const signal =
      artifact === "spotless-maven-plugin"
        ? spotlessMavenSignal(plugin)
        : isFmtPlugin(plugin)
          ? ({ kind: "fmt-plugin", plugin } as const)
          : null;
    if (hasKind(signal, "applied-elsewhere")) applied = signal;
    else if (signal) return signal;
  }
  return applied;
}

function spotlessMavenSignal(plugin: string): BuildSignal | null {
  const java = xmlElement(plugin, "java");
  if (java === null) {
    if (isOn(xmlElement(plugin, "skip"))) return { kind: "other" };
    return xmlElement(plugin, "configuration") === null ? { kind: "applied-elsewhere" } : null;
  }
  const google = xmlElement(java, "googleJavaFormat");
  const palantir = google === null ? xmlElement(java, "palantirJavaFormat") : null;
  if (google === null && palantir === null) {
    return OTHER_SPOTLESS_JAVA_ELEMENT.test(java) ? { kind: "other" } : null;
  }
  if (xmlElement(java, "toggleOffOn") !== null) return TOGGLE_NOTICE;
  const settings = google ?? palantir ?? "";
  if (xmlElement(settings, "groupArtifact") !== null) return FORK_NOTICE;
  const declaredVersion = xmlElement(settings, "version");
  const version: VersionRef =
    declaredVersion === null ? { kind: "spotless-default" } : mavenVersion(declaredVersion);
  const setting = (name: string) => xmlElement(settings, name)?.toLowerCase();
  // A property here could turn out to be any value; only versions are worth following that far.
  if (MAVEN_OPTIONS.some((name) => setting(name)?.includes("$"))) return UNREADABLE_OPTION_NOTICE;
  const customImportOrder = xmlElement(java, "importOrder") !== null;
  const scope = isOn(xmlElement(plugin, "skip")) ? "unreadable" : mavenScope(java);
  if (google !== null) {
    return {
      kind: "formatter",
      tool: GOOGLE_JAVA_FORMAT,
      version,
      scope,
      flags: googleFlags({
        style: setting("style"),
        reflow: setting("reflowLongStrings") === "true",
        reorderImports: setting("reorderImports") === "true",
        javadoc: setting("formatJavadoc") !== "false",
        customImportOrder,
      }),
    };
  }
  if (setting("formatJavadoc") === "true") return PALANTIR_JAVADOC_NOTICE;
  return {
    kind: "formatter",
    tool: PALANTIR_JAVA_FORMAT,
    version,
    scope,
    flags: palantirFlags(setting("style"), customImportOrder),
  };
}

/**
 * The fmt plugin's settings from its applied entry, then the `pluginManagement` entries it inherits,
 * nearest first, as Maven merges them. Its version of the formatter is the override's, else what
 * its own POM names.
 */
function fmtMavenSignal(plugins: readonly string[]): BuildSignal {
  const setting = (name: string): string | null => {
    for (const plugin of plugins) {
      const value = xmlElement(plugin, name);
      if (value !== null) return value;
    }
    return null;
  };
  const flag = (name: string, value: string, cliFlag: string) =>
    setting(name)?.toLowerCase() === value ? [cliFlag] : [];
  if (FMT_OPTIONS.some((name) => setting(name)?.includes("$"))) return UNREADABLE_OPTION_NOTICE;
  const override = plugins
    .flatMap((plugin) => xmlBlocks(plugin, "dependency"))
    .map(({ body }) => body)
    .find((dependency) => xmlElement(dependency, "artifactId") === GOOGLE_JAVA_FORMAT);
  const overridden = override ? xmlElement(override, "version") : null;
  const version: VersionRef = overridden
    ? mavenVersion(overridden)
    : {
        kind: "fmt-plugin",
        group: setting("groupId") ?? "",
        pluginVersion: mavenVersion(plugins.map(pluginOwnVersion).find(Boolean) ?? ""),
      };
  return {
    kind: "formatter",
    tool: GOOGLE_JAVA_FORMAT,
    version,
    scope: FMT_SCOPE_SETTINGS.some((name) => isOn(setting(name)))
      ? "unreadable"
      : { includes: MAVEN_SOURCES, excludes: [], inherited: true, excludeBuildDir: false },
    flags: [
      ...flag("style", "aosp", "--aosp"),
      ...flag("skipSortingImports", "true", SKIP_SORTING),
      ...flag("skipRemovingUnusedImports", "true", SKIP_UNUSED),
      // Unlike the command's, the plugin's default is to leave long strings alone.
      ...(setting("skipReflowingLongStrings")?.toLowerCase() === "false" ? [] : [REFLOW]),
    ],
  };
}

/** Whether a setting is present as anything but `false`: on, a path, or a property it may turn on. */
function isOn(value: string | null): boolean {
  return value !== null && value.toLowerCase() !== "false";
}

/** The plugin's `<version>`, before its configuration and dependencies can hold another. */
function pluginOwnVersion(plugin: string): string {
  const nested = plugin.search(/<(configuration|dependencies|executions)\b/);
  return xmlElement(nested === -1 ? plugin : plugin.slice(0, nested), "version") ?? "";
}

/** Spotless for Maven's own default, and where the fmt plugin looks unless told otherwise. */
function mavenScope(java: string): FileScope {
  const listed = (list: string, item: string) => {
    const element = xmlElement(java, list);
    return element === null ? [] : xmlBlocks(element, item).map(({ body }) => body.trim());
  };
  const includes = listed("includes", "include");
  const excludes = listed("excludes", "exclude");
  if (![...includes, ...excludes].every(isPlainGlob)) return "unreadable";
  return {
    includes: includes.length > 0 ? includes : MAVEN_SOURCES,
    excludes,
    inherited: true,
    excludeBuildDir: false,
  };
}

function mavenVersion(text: string): VersionRef {
  const property = /^\$\{([\w.-]+)\}$/.exec(text)?.[1];
  return property ? { kind: "maven-property", name: property } : literalVersion(text);
}

/*
 * These scan with `indexOf` and stop at the first element left open: a POM is the repository's, and
 * a lazy regular expression over unclosed tags takes quadratic time on the server's only thread.
 */

function withoutXmlComments(xml: string): string {
  let text = "";
  let from = 0;
  for (let open = xml.indexOf("<!--"); open !== -1; open = xml.indexOf("<!--", from)) {
    text += xml.slice(from, open);
    const close = xml.indexOf("-->", open + 4);
    if (close === -1) return text;
    from = close + 3;
  }
  return text + xml.slice(from);
}

/** Every `<name>...</name>` that does not nest in itself, as its range and inner text. */
function xmlBlocks(xml: string, name: string): { start: number; end: number; body: string }[] {
  const open = `<${name}>`;
  const close = `</${name}>`;
  const blocks = [];
  for (let start = xml.indexOf(open); start !== -1;) {
    const bodyStart = start + open.length;
    const closeAt = xml.indexOf(close, bodyStart);
    if (closeAt === -1) break;
    const end = closeAt + close.length;
    blocks.push({ start, end, body: xml.slice(bodyStart, closeAt) });
    start = xml.indexOf(open, end);
  }
  return blocks;
}

/** The trimmed text of the first `<name>` element, empty when self-closed, null when absent. */
function xmlElement(xml: string, name: string): string | null {
  const open = `<${name}`;
  for (let at = xml.indexOf(open); at !== -1; at = xml.indexOf(open, at + open.length)) {
    if (!/[\s/>]/.test(xml.charAt(at + open.length))) continue;
    const tagEnd = xml.indexOf(">", at);
    if (tagEnd === -1) return null;
    if (xml[tagEnd - 1] === "/") return "";
    const close = xml.indexOf(`</${name}>`, tagEnd);
    return close === -1 ? null : xml.slice(tagEnd + 1, close).trim();
  }
  return null;
}

function resolveMavenProperty(name: string, dirs: readonly string[]): string | undefined {
  for (const dir of dirs) {
    const properties = xmlElement(readPom(join(dir, "pom.xml")), "properties");
    const value = properties === null ? null : xmlElement(properties, name);
    if (value !== null) return VERSION.test(value) ? value : undefined;
  }
  return undefined;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Gradle

/** These take a parenthesis or, in Groovy, a space and an argument. */
const OTHER_SPOTLESS_JAVA_STEP =
  /\b(eclipse|prettier|clangFormat|greclipse)(?:\s*\(|[ \t]+[\w'"$])/;
const JAVA_BLOCK = /\bjava\s*\{/g;
/** Blocks that run a script's settings for other projects, whose directories its globs apply to. */
const INHERITING_BLOCK = /\b(?:subprojects|allprojects)\b[^{(;\n]*\{|\bconfigure\s*\([^)]*\)\s*\{/g;
/** Far above a real build; each block is scanned to its end, and the script is the repository's. */
const MAX_JAVA_BLOCKS = 64;
const TOGGLE_CALL = /\btoggleOffOn(?:\s*\(|[ \t]+[\w'"$])/;
const IMPORT_ORDER_CALL = /\bimportOrder(?:File)?(?:\s*\(|[ \t]+[\w'"$])/;
const APPLY_FALSE_LINE = /^.*\bapply\s*\(?\s*false.*$/gm;
const PLUGIN_ALIAS = /\balias\(\s*libs\.plugins\.([\w.]+)\s*\)/g;
const BOOLEAN_ARGUMENT = /^(true|false)?$/;
const BOOLEAN_STEPS = ["reflowLongStrings", "reorderImports", "formatJavadoc"];

function gradleSignal(script: string): BuildSignal | null {
  const javaBlocks = blockBodies(script, JAVA_BLOCK, MAX_JAVA_BLOCKS);
  const google = gradleCall(script, "googleJavaFormat");
  const palantir = google ? null : gradleCall(script, "palantirJavaFormat");
  const call = google ?? palantir;
  if (call) {
    if (javaBlocks.some((java) => TOGGLE_CALL.test(java))) return TOGGLE_NOTICE;
    if (call.chain.has("groupArtifact")) return FORK_NOTICE;
    const options = readGradleOptions(call.chain);
    if (!options) return UNREADABLE_OPTION_NOTICE;
    const version: VersionRef = call.argument
      ? gradleVersion(call.argument, script)
      : { kind: "spotless-default" };
    const scope = gradleScope(
      javaBlocks.filter((java) => /\b(googleJavaFormat|palantirJavaFormat)\b/.test(java)),
      script,
    );
    const customImportOrder = javaBlocks.some((java) => IMPORT_ORDER_CALL.test(java));
    if (google) {
      return {
        kind: "formatter",
        tool: GOOGLE_JAVA_FORMAT,
        version,
        scope,
        flags: googleFlags({
          style: call.chain.has("aosp") ? "aosp" : options.style,
          reflow: options.enabled("reflowLongStrings"),
          reorderImports: options.enabled("reorderImports"),
          javadoc: !call.chain.has("skipJavadocFormatting") && options.javadoc !== "false",
          customImportOrder,
        }),
      };
    }
    if (call.chain.has("formatJavadoc") && options.javadoc !== "false") {
      return PALANTIR_JAVADOC_NOTICE;
    }
    return {
      kind: "formatter",
      tool: PALANTIR_JAVA_FORMAT,
      version,
      scope,
      flags: palantirFlags(options.style, customImportOrder),
    };
  }
  if (javaBlocks.some((java) => OTHER_SPOTLESS_JAVA_STEP.test(java))) return { kind: "other" };
  // `apply false` only makes a plugin available, to the modules that go on to apply it.
  const applied = script.replace(APPLY_FALSE_LINE, "");
  if (declaresPlugin(applied, PALANTIR_PLUGIN) || applied.includes(PALANTIR_PLUGIN_COORDINATE)) {
    return palantirPluginSignal(script);
  }
  const aliases = [...applied.matchAll(PLUGIN_ALIAS)].map(([, alias = ""]) => alias);
  return aliases.length > 0 ? { kind: "plugin-aliases", aliases } : null;
}

/** `target` and `targetExclude` of the Java blocks holding the formatter, when plain globs. */
function gradleScope(javaBlocks: readonly string[], script: string): FileScope {
  const blocks = javaBlocks.join("\n");
  if (/\btargetExcludeIfContent/.test(blocks)) return "unreadable";
  const includes = gradleGlobs(blocks, "target");
  const excludes = gradleGlobs(blocks, "targetExclude");
  if (includes === undefined || excludes === undefined) return "unreadable";
  return {
    includes,
    excludes: excludes ?? [],
    inherited: blockBodies(script, INHERITING_BLOCK, MAX_JAVA_BLOCKS).some((body) =>
      javaBlocks.some((java) => body.includes(java)),
    ),
    excludeBuildDir: true,
  };
}

/** The call's glob arguments; null with no such call, undefined when they cannot be read. */
function gradleGlobs(blocks: string, name: string): string[] | null | undefined {
  const calls = [...blocks.matchAll(new RegExp(`(?<![.\\w"'/-])${name}\\b`, "g"))];
  const [call] = calls;
  if (!call) return null;
  if (calls.length > 1) return undefined;
  const after = call.index + name.length;
  const rest = blocks.slice(after);
  const paren = /^\s*\(/.exec(rest);
  // Groovy's list goes on past a line that ends in a comma.
  const groovy = /^[ \t]+((?:[^\s}][^}\n;]*,[ \t]*\r?\n[ \t]*)*[^\s}][^}\n;]*)/.exec(rest);
  const argumentText = paren
    ? blocks.slice(after + paren[0].length, closingParen(blocks, after + paren[0].length))
    : groovy?.[1];
  // Without parentheses, ending in a comma means the list was cut short, losing an exclude.
  if (argumentText === undefined || (!paren && argumentText.trimEnd().endsWith(","))) {
    return undefined;
  }
  const globs = argumentText
    .split(",")
    .map((argument) => argument.trim())
    .filter(Boolean)
    .map(stringLiteral);
  return globs.length > 0 && globs.every((glob) => glob !== undefined && isPlainGlob(glob))
    ? globs.filter((glob) => glob !== undefined)
    : undefined;
}

function palantirPluginSignal(script: string): BuildSignal {
  return {
    kind: "formatter",
    tool: PALANTIR_JAVA_FORMAT,
    version: { kind: "plugin", script },
    flags: palantirFlags(undefined, false),
    scope: { includes: null, excludes: [], inherited: true, excludeBuildDir: true },
  };
}

/** The plugin, when one of `aliases` names it in the catalog that applies. */
function palantirByAlias(aliases: readonly string[], dirs: readonly string[]): BuildSignal | null {
  for (const catalog of catalogs(dirs)) {
    const plugins = recordAt(catalog, "plugins");
    for (const alias of aliases) {
      const entry = aliasEntry(plugins, alias);
      const id =
        typeof entry === "string" ? entry.split(":")[0] : isRecord(entry) ? entry.id : null;
      if (id === PALANTIR_PLUGIN) return palantirPluginSignal("");
    }
  }
  return null;
}

/** A chain's options, or null when one is an expression that could turn out to be anything. */
function readGradleOptions(chain: Map<string, string>) {
  const styleArgument = chain.get("style");
  const style = stringLiteral(styleArgument ?? "");
  if (styleArgument !== undefined && style === undefined) return null;
  const readable = BOOLEAN_STEPS.every((name) => BOOLEAN_ARGUMENT.test(chain.get(name) ?? ""));
  if (!readable) return null;
  return {
    style: style?.toLowerCase(),
    javadoc: chain.get("formatJavadoc"),
    enabled: (name: string) => chain.has(name) && chain.get(name) !== "false",
  };
}

/** `name(argument).step(argument)...` or Groovy's `name 'argument'`, not `libs.name` or `val name`. */
function gradleCall(
  script: string,
  name: string,
): { argument: string; chain: Map<string, string> } | null {
  const start = new RegExp(
    `(?<![.\\w"'-])(?<!\\b(?:task|fun|def|void)\\s+)${name}\\s*(\\(|(?=['"]))`,
  ).exec(script);
  if (!start) return null;
  const after = start.index + start[0].length;
  if (!start[1]) {
    const groovyArgument = /^(['"])[^'"]*\1/.exec(script.slice(after))?.[0] ?? "";
    return { argument: groovyArgument, chain: new Map() };
  }
  const end = closingParen(script, after);
  const chain = new Map<string, string>();
  const step = /\s*\.\s*(\w+)\s*\(/y;
  step.lastIndex = end + 1;
  for (let match = step.exec(script); match; match = step.exec(script)) {
    const stepStart = step.lastIndex;
    const stepEnd = closingParen(script, stepStart);
    chain.set(match[1] ?? "", script.slice(stepStart, stepEnd).trim());
    step.lastIndex = stepEnd + 1;
  }
  return { argument: script.slice(after, end).trim(), chain };
}

function closingParen(script: string, start: number): number {
  let depth = 1;
  let i = start;
  for (; i < script.length; i += 1) {
    if (script[i] === "(") depth += 1;
    if (script[i] === ")") depth -= 1;
    if (depth === 0) return i;
  }
  return i;
}

function gradleVersion(argument: string, script: string): VersionRef {
  const literal = stringLiteral(argument);
  if (literal !== undefined && !literal.includes("$")) return literalVersion(literal);
  const catalogVersion = /^libs\.versions\.([\w.]+)\.get\(\)$/.exec(argument)?.[1];
  if (catalogVersion) return { kind: "catalog-version", alias: catalogVersion };
  const catalogLibrary = /^libs\.([\w.]+)\.get\(\)\.(?:version|getVersion\(\))$/.exec(
    argument,
  )?.[1];
  if (catalogLibrary) return { kind: "catalog-library", alias: catalogLibrary };
  const variable = /^["']?\$?\{?(\w+)\}?["']?$/.exec(argument)?.[1];
  return variable ? { kind: "gradle-variable", name: variable, script } : { kind: "unreadable" };
}

function stringLiteral(text: string): string | undefined {
  return /^(['"])([^'"]*)\1$/.exec(text)?.[2];
}

function resolveGradleVariable(
  name: string,
  script: string,
  dirs: readonly string[],
): string | undefined {
  const assigned = new RegExp(
    `\\b(?:def|val|var|String|ext\\.)\\s*${name}\\s*(?::\\s*String\\s*)?=\\s*['"]([^'"]+)['"]`,
  ).exec(script)?.[1];
  if (assigned) return versionOrUndefined(assigned);
  const property = new RegExp(`^[ \\t]*${name}[ \\t]*[=:][ \\t]*(\\S+)[ \\t]*$`, "m");
  for (const dir of dirs) {
    const value = property.exec(readText(join(dir, "gradle.properties")))?.[1];
    if (value) return versionOrUndefined(value);
  }
  return undefined;
}

function resolveCatalogVersion(alias: string, dirs: readonly string[]): string | undefined {
  for (const catalog of catalogs(dirs)) {
    const value = aliasEntry(recordAt(catalog, "versions"), alias);
    if (typeof value === "string") return versionOrUndefined(value);
  }
  return undefined;
}

function resolveCatalogLibrary(alias: string, dirs: readonly string[]): string | undefined {
  for (const catalog of catalogs(dirs)) {
    const entry = aliasEntry(recordAt(catalog, "libraries"), alias);
    if (entry !== undefined) return catalogEntryVersion(entry, catalog);
  }
  return undefined;
}

/** A catalog entry's version: `"g:a:v"`, `version = "v"` or `version.ref = "x"`. */
function catalogEntryVersion(entry: unknown, catalog: Record<string, unknown>): string | undefined {
  if (typeof entry === "string") return versionOrUndefined(entry.split(":")[2] ?? "");
  if (!isRecord(entry)) return undefined;
  const { version } = entry;
  if (typeof version === "string") return versionOrUndefined(version);
  const ref = isRecord(version) ? version.ref : undefined;
  const referenced = typeof ref === "string" ? recordAt(catalog, "versions")?.[ref] : undefined;
  return typeof referenced === "string" ? versionOrUndefined(referenced) : undefined;
}

function* catalogs(dirs: readonly string[]): Generator<Record<string, unknown>> {
  for (const dir of dirs) {
    const catalog = readToml(join(dir, CATALOG));
    if (catalog) yield catalog;
  }
}

/** The entry an accessor names: Gradle turns `-` and `_` in an alias into `.`. */
function aliasEntry(table: Record<string, unknown> | undefined, alias: string): unknown {
  if (!table) return undefined;
  const key = Object.keys(table).find((name) => name.replace(/[-_]/g, ".") === alias);
  return key === undefined ? undefined : table[key];
}

/** The plugin shares its version with the formatter, as they are released from one repository. */
function resolvePluginVersion(script: string, dirs: readonly string[]): string | undefined {
  const scripts = [
    script,
    ...dirs.flatMap((dir) => [
      readCode(join(dir, "build.gradle.kts"), "kotlin"),
      readCode(join(dir, "build.gradle"), "groovy"),
      readCode(join(dir, "settings.gradle.kts"), "kotlin"),
      readCode(join(dir, "settings.gradle"), "groovy"),
    ]),
  ];
  const pattern = new RegExp(
    `(?:${PALANTIR_PLUGIN_COORDINATE}:|["']${escapeRegExp(PALANTIR_PLUGIN)}["']\\s*\\)?\\s*version\\s*\\(?\\s*["'])([^"':]+)["']`,
  );
  for (const text of scripts) {
    const version = pattern.exec(text)?.[1];
    if (version) return versionOrUndefined(version);
  }
  for (const catalog of catalogs(dirs)) {
    const version = pluginVersionInCatalog(catalog);
    if (version) return version;
  }
  return undefined;
}

function pluginVersionInCatalog(catalog: Record<string, unknown>): string | undefined {
  for (const entry of Object.values(recordAt(catalog, "plugins") ?? {})) {
    if (typeof entry === "string" && entry.startsWith(`${PALANTIR_PLUGIN}:`)) {
      return versionOrUndefined(entry.slice(PALANTIR_PLUGIN.length + 1));
    }
    if (isRecord(entry) && entry.id === PALANTIR_PLUGIN) return catalogEntryVersion(entry, catalog);
  }
  for (const entry of Object.values(recordAt(catalog, "libraries") ?? {})) {
    const named =
      typeof entry === "string"
        ? entry.startsWith(PALANTIR_PLUGIN_COORDINATE)
        : isRecord(entry) && entry.module === PALANTIR_PLUGIN_COORDINATE;
    if (named) return catalogEntryVersion(entry, catalog);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Shared

/** The version a reference leads to, undefined when it cannot be read. */
function resolveVersion(ref: VersionRef, dirs: readonly string[]): string | undefined {
  switch (ref.kind) {
    case "fmt-plugin": {
      const pluginVersion = resolveVersion(ref.pluginVersion, dirs);
      return pluginVersion ? fmtPluginFormatterVersion(ref.group, pluginVersion) : undefined;
    }
    case "literal":
      return ref.version;
    case "maven-property":
      return resolveMavenProperty(ref.name, dirs);
    case "gradle-variable":
      return resolveGradleVariable(ref.name, ref.script, dirs);
    case "catalog-version":
      return resolveCatalogVersion(ref.alias, dirs);
    case "catalog-library":
      return resolveCatalogLibrary(ref.alias, dirs);
    case "plugin":
      return resolvePluginVersion(ref.script, dirs);
    case "spotless-default":
    case "unreadable":
    default:
      return undefined;
  }
}

/** What the plugin's published POM, in the user's Maven cache once a build has used it, depends on. */
function fmtPluginFormatterVersion(group: string, pluginVersion: string): string | undefined {
  const repository = join(buildSpawnEnv().HOME ?? homedir(), ".m2", "repository");
  const name = `fmt-maven-plugin-${pluginVersion}.pom`;
  const path = join(repository, ...group.split("."), "fmt-maven-plugin", pluginVersion, name);
  const pom = withoutXmlComments(readText(path));
  const dependency = xmlBlocks(pom, "dependency").find(
    ({ body }) => xmlElement(body, "artifactId") === GOOGLE_JAVA_FORMAT,
  );
  const version = dependency && xmlElement(dependency.body, "version");
  if (!version) return undefined;
  const property = /^\$\{([\w.-]+)\}$/.exec(version)?.[1];
  const properties = xmlElement(pom, "properties");
  const value = property ? properties && xmlElement(properties, property) : version;
  return value ? versionOrUndefined(value) : undefined;
}

/** Whether the file being saved is one the declaration formats. */
function isInScope(scope: FileScope, file: string, dirsUpToDeclaring: readonly string[]): boolean {
  if (scope === "unreadable") return false;
  const declaring = dirsUpToDeclaring.at(-1) ?? "";
  const bases = scope.inherited
    ? dirsUpToDeclaring.filter((dir) => dir === declaring || hasBuildFile(dir))
    : [declaring];
  const fromBases = bases.map((base) => relative(base, file).split(sep).join("/"));
  if (scope.excludeBuildDir && fromBases.some((path) => path.startsWith("build/"))) return false;
  const matches = (globs: readonly string[]) =>
    fromBases.some((path) => globs.some((glob) => new Bun.Glob(antGlob(glob)).match(path)));
  return !matches(scope.excludes) && (scope.includes === null || matches(scope.includes));
}

function hasBuildFile(dir: string): boolean {
  return BUILD_FILES.some((name) => existsSync(join(dir, name)));
}

/** A glob with nothing Ant and `Bun.Glob` read differently, and no variable or path out of a project. */
function isPlainGlob(glob: string): boolean {
  return glob !== "" && !/[$[\]{}!\\]/.test(glob) && !glob.startsWith("/") && !glob.includes("..");
}

/** Ant's trailing slash stands for everything under the directory. */
function antGlob(glob: string): string {
  return glob.endsWith("/") ? `${glob}**` : glob;
}

function literalVersion(text: string): VersionRef {
  return VERSION.test(text) ? { kind: "literal", version: text } : { kind: "unreadable" };
}

/** Only a version: it goes into a cache path and a notice, and a project chooses it. */
function versionOrUndefined(text: string): string | undefined {
  return VERSION.test(text) ? text : undefined;
}

/**
 * The flags reproducing Spotless's step, whose defaults differ from the command's: it leaves long
 * strings alone, and sorts imports in Google order unless told to reorder them for the style. The
 * command sorts in its style's order, so AOSP without `reorderImports` leaves imports as they are,
 * as does an `importOrder` step, which has the last word on them in the build.
 */
function googleFlags(options: {
  style: string | undefined;
  reflow: boolean;
  reorderImports: boolean;
  javadoc: boolean;
  customImportOrder: boolean;
}): string[] {
  const aosp = options.style === "aosp";
  return [
    ...(aosp ? ["--aosp"] : []),
    ...((aosp && !options.reorderImports) || options.customImportOrder ? [SKIP_SORTING] : []),
    ...(options.reflow ? [] : [REFLOW]),
    ...(options.javadoc ? [] : [SKIP_JAVADOC]),
  ];
}

/** The command's default style is Google's, while Spotless and the plugin default to Palantir's. */
function palantirFlags(style: string | undefined, customImportOrder: boolean): string[] {
  const styleFlags = style === "aosp" ? ["--aosp"] : style === "google" ? [] : ["--palantir"];
  return [...styleFlags, ...(customImportOrder ? [SKIP_SORTING] : []), REFLOW];
}
