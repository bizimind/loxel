import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, join, parse, resolve } from "node:path";

import { isVersionManagerShim as isInShimsDir } from "./csharp-env";
import { getJavaEnv, isJdkInWorktree, javaExecutable, listJavaRuntimes } from "./java-env";
import {
  findJavaFormatDeclaration,
  GOOGLE_JAVA_FORMAT,
  type JavaFormatDeclaration,
  PALANTIR_JAVA_FORMAT,
} from "./java-format-declaration";
import { NO_JAVA, trustedPath, withWorktreeJdk } from "./kotlin-formatter";
import type {
  FileFormatter,
  FormatterDecline,
  FormatterFailure,
  FormatterSpawnOptions,
  LanguageFormatter,
} from "./language-formatter";
import { logger } from "./logger";
import { linksToVersionManager } from "./rust-tool-shim";
import { buildSpawnEnv } from "./shell-env";

const log = logger.child("format");

const TOOLS: ReadonlySet<string> = new Set([GOOGLE_JAVA_FORMAT, PALANTIR_JAVA_FORMAT]);

export const javaFormatter: LanguageFormatter = {
  extensions: ["java"],
  detect: detectJavaFormatter,
  spawnOptions: javaSpawnOptions,
  failureNotice: javaFailureNotice,
};

const VERSION_TIMEOUT_MS = 5_000;
const PROBE_TIMEOUT_MS = 5_000;
const VERSION_LINE = /^\S+:\s*Version\s+(\d\S*)/m;

const GJF_MAIN = "com.google.googlejavaformat.java.Main";
/** The compiler internals google-java-format reaches into, which a jar's launcher would open. */
const JAVAC_EXPORTS = ["api", "code", "file", "main", "parser", "tree", "util"].map(
  (pkg) => `--add-exports=jdk.compiler/com.sun.tools.javac.${pkg}=ALL-UNNAMED`,
);
/** A short-lived JVM: these take a few hundred milliseconds off every save. */
const JVM_FLAGS = ["-XX:TieredStopAtLevel=1", "-XX:+UseSerialGC", "-Xshare:auto"];
/**
 * google-java-format's runtime dependencies. Commonmark is what newer versions format Markdown
 * doc comments with. Any version in the cache does: they do not shape the output, and the probe
 * below proves the set works together.
 */
const GJF_DEPENDENCIES = [
  { group: "com.google.guava", artifact: "guava", suffix: "-jre" },
  { group: "com.google.guava", artifact: "failureaccess", suffix: "" },
  { group: "org.commonmark", artifact: "commonmark", suffix: "" },
  { group: "org.commonmark", artifact: "commonmark-ext-gfm-tables", suffix: "" },
];
/** Reaches the classes a formatter loads late, so a missing one shows here and not on a save. */
const PROBE_SOURCE = "import java.util.List;\n\n/// A *doc*.\nclass A {\n  List<String> a;\n}\n";

/**
 * Pick how to format a Java file: only reads build files, and leaves what needs running a tool to
 * `prepare`. A project that declares no formatter is not formatted on save.
 */
function detectJavaFormatter(
  startDir: string,
  wtRoot: string,
): FileFormatter | FormatterDecline | null {
  const declared = findJavaFormatDeclaration(startDir, wtRoot);
  if (!declared || "notice" in declared) return declared;
  return {
    command: declared.tool,
    args: formatArgs(declared.flags),
    prepare: () => prepareJavaFormat(declared, resolve(wtRoot)),
  };
}

function formatArgs(flags: readonly string[]): string {
  return [...flags, "--assume-filename={file}", "-"].join(" ");
}

/**
 * The tool at the version the project pins, or a decline saying how to get it: another version
 * would rewrite code the pinned one left alone. On `PATH` first, then, for google-java-format, the
 * jar a build left in the user's Maven or Gradle cache. A tool in the worktree or a version
 * manager's shim is not used, nor is anything from the worktree spawned.
 */
async function prepareJavaFormat(
  { tool, pin, flags }: JavaFormatDeclaration,
  root: string,
): Promise<FileFormatter | FormatterDecline> {
  const { tools, sawShim } = await toolsOnPath(tool, root);
  const first = tools[0];
  if (first && pin === null) return { command: first, args: formatArgs(flags) };
  const versions: string[] = [];
  for (const path of tools) {
    const version = await toolVersion(path, tool, root);
    if (version === pin) return { command: path, args: formatArgs(flags) };
    if (version) versions.push(version);
  }
  if (pin && tool === GOOGLE_JAVA_FORMAT) {
    const cached = await cachedJarFormatter(pin, flags, root);
    if (cached) return cached;
  }
  return { notice: unavailableNotice(tool, pin, versions[0], sawShim) };
}

function unavailableNotice(
  tool: string,
  pin: string | null,
  found: string | undefined,
  sawShim: boolean,
): string {
  const skipped = "Format on save skipped:";
  const install = installHint(tool, pin);
  if (pin && found) {
    return `${skipped} this project pins ${tool} ${pin}, and the one on your PATH is ${found}. ${install}`;
  }
  if (sawShim) {
    return `${skipped} "${tool}" on your PATH is a version manager's shim, which Loxel doesn't run. Add the tool's own directory to your PATH.`;
  }
  const wanted = pin ? `${tool} ${pin}` : tool;
  return `${skipped} this project uses ${wanted}, which is not on your PATH. ${install}`;
}

function installHint(tool: string, pin: string | null): string {
  if (tool === PALANTIR_JAVA_FORMAT) {
    return `Install ${pin ? `version ${pin}` : "it"} from its Maven Central releases.`;
  }
  if (pin) {
    return `Install ${pin} from its GitHub releases, or run Spotless once so the build caches it.`;
  }
  return "Install it, for example with `brew install google-java-format`.";
}

/** Every copy of `tool` on the trusted part of `PATH`, without version managers' shims. */
async function toolsOnPath(
  tool: string,
  root: string,
): Promise<{ tools: string[]; sawShim: boolean }> {
  const tools: string[] = [];
  let sawShim = false;
  for (const dir of (await trustedPath(tool, root)).split(delimiter)) {
    const found = dir && Bun.which(tool, { PATH: dir });
    if (!found) continue;
    if ((await isInShimsDir(found)) || (await linksToVersionManager(found))) {
      sawShim = true;
    } else {
      tools.push(found);
    }
  }
  return { tools, sawShim };
}

const versionCache = new Map<string, Promise<string | null>>();

/**
 * The tool's version, cached by its path, size and mtime. Asked from the filesystem root, by
 * absolute path, so a launcher reads nothing from the project. A failure is not cached: installing
 * a JDK can fix it.
 */
function toolVersion(path: string, tool: string, root: string): Promise<string | null> {
  const key = fileKey(path);
  const cached = versionCache.get(key);
  if (cached) return cached;
  const asked = askVersion(path, tool, root).then((version) => {
    if (!version) versionCache.delete(key);
    return version;
  });
  versionCache.set(key, asked);
  return asked;
}

async function askVersion(path: string, tool: string, root: string): Promise<string | null> {
  try {
    const proc = Bun.spawn([path, "--version"], {
      cwd: parse(root).root,
      env: { ...buildSpawnEnv(), ...(await withWorktreeJdk(await trustedPath(tool, root), root)) },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: VERSION_TIMEOUT_MS,
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    // `name: Version 1.2.3`, on either stream; a JVM's error can hold the word "version" too.
    return exitCode === 0 ? (VERSION_LINE.exec(`${stdout}\n${stderr}`)?.[1] ?? null) : null;
  } catch (err) {
    log.debug("Asking a formatter for its version failed", { path, error: err });
    return null;
  }
}

function fileKey(path: string): string {
  const info = statSync(path, { throwIfNoEntry: false });
  return `${path}\0${info?.size ?? 0}\0${info?.mtimeMs ?? 0}`;
}

// ---------------------------------------------------------------------------
// The jar a build left in the user's caches

/** Runs the pinned jar from the caches, a decline when no JDK runs it, null when it isn't there. */
async function cachedJarFormatter(
  version: string,
  flags: readonly string[],
  root: string,
): Promise<FileFormatter | FormatterDecline | null> {
  const jar = cachedJar("com.google.googlejavaformat", GOOGLE_JAVA_FORMAT, version);
  if (!jar) return null;
  const classpath = [jar];
  for (const { group, artifact, suffix } of GJF_DEPENDENCIES) {
    const dependency = newestCachedJar(group, artifact, suffix);
    if (dependency) classpath.push(dependency);
  }
  // The seam's arguments split on whitespace, and `:` separates the classpath.
  if (classpath.some((path) => /[\s:]/.test(path))) return null;
  // A home or Gradle home inside the worktree holds the repository's jars, not a build's.
  if (classpath.some((path) => isJdkInWorktree(path, root))) return null;
  const javaArgs = [...JVM_FLAGS, ...JAVAC_EXPORTS, "-cp", classpath.join(delimiter), GJF_MAIN];
  const java = await jdkRunning(jar, javaArgs, root);
  if (java) jarRunners.add(java);
  if (!java) {
    return {
      notice: `Format on save skipped: ${GOOGLE_JAVA_FORMAT} ${version} from your build's cache doesn't run on any JDK Loxel found. Install a JDK it supports, or ${GOOGLE_JAVA_FORMAT} ${version} itself.`,
    };
  }
  return { command: java, args: [...javaArgs, formatArgs(flags)].join(" ") };
}

function mavenRepository(): string {
  return join(buildSpawnEnv().HOME ?? homedir(), ".m2", "repository");
}

function gradleModules(): string {
  const env = buildSpawnEnv();
  const gradleHome = env.GRADLE_USER_HOME ?? join(env.HOME ?? homedir(), ".gradle");
  return join(gradleHome, "caches", "modules-2", "files-2.1");
}

function cachedJar(group: string, artifact: string, version: string): string | null {
  const name = `${artifact}-${version}.jar`;
  const inMaven = join(mavenRepository(), ...group.split("."), artifact, version, name);
  if (existsSync(inMaven)) return inMaven;
  const gradleDir = join(gradleModules(), group, artifact, version);
  for (const hash of listDir(gradleDir)) {
    const inGradle = join(gradleDir, hash, name);
    if (existsSync(inGradle)) return inGradle;
  }
  return null;
}

function newestCachedJar(group: string, artifact: string, suffix: string): string | null {
  const versions = [
    ...listDir(join(mavenRepository(), ...group.split("."), artifact)),
    ...listDir(join(gradleModules(), group, artifact)),
  ].filter((version) => version.endsWith(suffix));
  const newestFirst = [...new Set(versions)].sort((a, b) =>
    b.localeCompare(a, undefined, { numeric: true }),
  );
  for (const version of newestFirst) {
    const jar = cachedJar(group, artifact, version);
    if (jar) return jar;
  }
  return null;
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Each `java` chosen to run a cached jar, which is how a spawn tells it from a manual override's. */
const jarRunners = new Set<string>();

interface JdkAnswer {
  java: string | null;
  /** What `java` was when it ran the jar. */
  javaKey: string | null;
  /** The JDKs tried, for an answer of none. */
  candidates: string;
}

const jdkForJar = new Map<string, JdkAnswer>();

/**
 * The `java` that runs the jar, the worktree's JDK first and then the newest, since a JDK parses no
 * newer syntax than its own. Which versions run on which JDK follows no simple rule (1.23 fails on
 * Java 25, 1.30 needs 21), so each is tried. A JDK that ran it is kept while it stays the same file,
 * and an answer of none while the JDKs on offer stay the same, unless a try timed out, which says
 * nothing about the JDK on a busy machine.
 */
async function jdkRunning(
  jar: string,
  javaArgs: readonly string[],
  root: string,
): Promise<string | null> {
  const key = [root, fileKey(jar), ...javaArgs].join("\0");
  const known = jdkForJar.get(key);
  if (known?.java && known.javaKey === fileKey(known.java)) return known.java;
  const executables = await candidateJavas(root);
  const candidates = executables.join(delimiter);
  if (known && !known.java && known.candidates === candidates) return null;
  let conclusive = true;
  for (const java of executables) {
    const outcome = await tryFormatter(java, javaArgs, root);
    if (outcome === "runs") {
      jdkForJar.set(key, { java, javaKey: fileKey(java), candidates });
      return java;
    }
    if (outcome === "timed-out") conclusive = false;
  }
  if (conclusive) jdkForJar.set(key, { java: null, javaKey: null, candidates });
  else jdkForJar.delete(key);
  return null;
}

async function candidateJavas(root: string): Promise<string[]> {
  const [chosen, listed] = await Promise.all([getJavaEnv(root), listJavaRuntimes(root)]);
  const homes = [...(chosen ? [chosen.path] : []), ...listed.map((runtime) => runtime.path)];
  return [...new Set(homes)]
    .filter((home) => !isJdkInWorktree(home, root))
    .map((home) => javaExecutable(home));
}

async function tryFormatter(
  java: string,
  javaArgs: readonly string[],
  root: string,
): Promise<"runs" | "fails" | "timed-out"> {
  try {
    const proc = Bun.spawn([java, ...javaArgs, "-"], {
      cwd: parse(root).root,
      env: { ...buildSpawnEnv(), PATH: await trustedPath("java", root) },
      stdin: new TextEncoder().encode(PROBE_SOURCE),
      stdout: "pipe",
      stderr: "ignore",
      timeout: PROBE_TIMEOUT_MS,
    });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (proc.signalCode) return "timed-out";
    return exitCode === 0 && stdout.includes("class A") ? "runs" : "fails";
  } catch (err) {
    log.debug("A JDK could not run a formatter jar", { java, error: err });
    return "fails";
  }
}

// ---------------------------------------------------------------------------
// Running

/**
 * From the filesystem root, with `{file}` absolute: these read no project files, and a shim that
 * reached this point through a manual override finds no pin there. `PATH` holds no worktree
 * directory, so a launcher script picks up no committed `java`.
 */
async function javaSpawnOptions(
  command: string,
  _dir: string,
  wtRoot: string,
): Promise<FormatterSpawnOptions> {
  const name = basename(command);
  // Any other `java` is a manual override, whose relative arguments need the default directory.
  if (!TOOLS.has(name) && !jarRunners.has(command)) return {};
  const root = resolve(wtRoot);
  return {
    cwd: parse(root).root,
    env: await withWorktreeJdk(await trustedPath(name, root), root),
    binDirs: [],
  };
}

/** A launcher's failures the user can fix. A syntax error exits non-zero too, and only logs. */
function javaFailureNotice(failure: FormatterFailure): string | undefined {
  if (failure.kind !== "exited" || !TOOLS.has(basename(failure.command))) return undefined;
  const tool = basename(failure.command);
  if (NO_JAVA.test(failure.stderr)) {
    return `Format on save skipped: ${tool} needs Java. Install a JDK.`;
  }
  if (failure.stderr.includes("UnsupportedClassVersionError")) {
    return `Format on save skipped: ${tool} needs a newer JDK than the one it found.`;
  }
  return undefined;
}
