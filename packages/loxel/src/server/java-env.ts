import { existsSync, readdirSync, watch, type Dirent, type FSWatcher } from "node:fs";
import { access, constants, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type { JavaEnv, JavaEnvSource, JavaRuntime } from "@/api/java-env-model";
import { isDirectory } from "@/fs-utils";

import { getJavaOverride } from "./java-override-store";
import { logger } from "./logger";
import { buildSpawnEnv } from "./shell-env";
import { isEnvShippedByRepo, isShippedByRepo } from "./shipped-by-repo";

const log = logger.child("server");

const IS_WINDOWS = process.platform === "win32";
const JAVA = IS_WINDOWS ? "java.exe" : "java";
const JAVAC = IS_WINDOWS ? "javac.exe" : "javac";

/** Lists the JDKs macOS knows about; answers without a dialog when there are none. */
const MACOS_JAVA_HOME_TOOL = "/usr/libexec/java_home";
const JAVA_HOME_TOOL_TIMEOUT_MS = 5000;
/** A JDK's `release` file is a couple of kilobytes; read no more than this of a stranger's. */
const RELEASE_FILE_MAX_BYTES = 64 * 1024;
/** Quiet period after the last filesystem event before re-resolving (installers write in bursts). */
const WATCH_DEBOUNCE_MS = 1000;
/** How long a replaced watch keeps running beside its replacement. */
const WATCH_OVERLAP_MS = 1000;

type SpawnEnv = Record<string, string | undefined>;

/** A directory holding one JDK per entry. */
export interface JavaInstallRoot {
  dir: string;
  /** Only entries with this name prefix can be JDKs (Homebrew's `opt` holds every formula). */
  entryPrefix?: string;
  /** JDKs may sit one level further down (Gradle's `<vendor>-<level>/jdk-<version>`). */
  nested?: boolean;
}

/** Well-known places JDKs are installed, whether or not they exist on this machine. */
export function javaInstallRoots(
  env: SpawnEnv,
  platform: NodeJS.Platform = process.platform,
): JavaInstallRoot[] {
  const home = env.HOME ?? homedir();
  const toolRoots = [
    { dir: path.join(home, ".jdks") },
    { dir: path.join(env.GRADLE_USER_HOME ?? path.join(home, ".gradle"), "jdks"), nested: true },
  ];
  if (platform === "win32") {
    const programFiles = env.ProgramFiles ?? "C:\\Program Files";
    return [
      { dir: path.join(programFiles, "Java") },
      { dir: path.join(programFiles, "Eclipse Adoptium") },
      ...toolRoots,
    ];
  }
  const dataHome = env.XDG_DATA_HOME ?? path.join(home, ".local", "share");
  const homebrewRoots = (prefixes: string[]) =>
    prefixes.map((prefix) => ({ dir: path.join(prefix, "opt"), entryPrefix: "openjdk" }));
  // Only this platform's system locations: watching for a root that cannot appear costs events.
  const systemRoots =
    platform === "darwin"
      ? [
          { dir: "/Library/Java/JavaVirtualMachines" },
          { dir: path.join(home, "Library", "Java", "JavaVirtualMachines") },
          ...homebrewRoots(["/opt/homebrew", "/usr/local"]),
        ]
      : [...homebrewRoots(["/home/linuxbrew/.linuxbrew"]), { dir: "/usr/lib/jvm" }];
  return [
    ...systemRoots,
    { dir: path.join(env.SDKMAN_DIR ?? path.join(home, ".sdkman"), "candidates", "java") },
    { dir: path.join(env.ASDF_DATA_DIR ?? path.join(home, ".asdf"), "installs", "java") },
    { dir: path.join(env.MISE_DATA_DIR ?? path.join(dataHome, "mise"), "installs", "java") },
    ...toolRoots,
  ];
}

export interface ResolveJavaEnvOptions {
  /**
   * JDK home chosen explicitly for this worktree; wins whenever it is usable. Defaults to the one
   * the user chose for the worktree (see `java-override-store.ts`); null skips any override.
   */
  overridePath?: string | null;
  /** Environment for `JAVA_HOME`, `PATH` and install roots. Defaults to the login-shell spawn environment. */
  env?: SpawnEnv;
  /** The macOS `java_home` tool; null skips it. Defaults to the system's on macOS. */
  javaHomeTool?: string | null;
  /** Where to look for installed JDKs. Defaults to {@link javaInstallRoots}. */
  installRoots?: JavaInstallRoot[];
}

/** A resolution: the JDK, and what `JAVA_HOME` held if it had to be ignored. */
export interface JavaEnvResolution {
  env: JavaEnv | null;
  ignoredJavaHome: string | null;
}

// ---------------------------------------------------------------------------
// The shared, memoized resolution per worktree

/** What a {@link subscribeJavaEnv} listener hears after each finished resolution. */
export interface JavaEnvUpdate {
  env: JavaEnv | null;
  /** The worktree's first resolution since it was subscribed. */
  first: boolean;
  /** The JDK, the chosen override or the ignored `JAVA_HOME` differs from the previous resolution's. */
  changed: boolean;
}

interface WorktreeJavaEnv {
  listeners: Set<(update: JavaEnvUpdate) => void>;
  /** The latest resolution, finished or not; null until something asks for the JDK. */
  resolution: Promise<JavaEnvResolution> | null;
  /** The last finished resolution and the override it was made with. */
  settled: { resolution: JavaEnvResolution; overridePath: string | null } | null;
  /** The settled JDK failed the trust rule since, and a re-resolution has been started for that. */
  withdrawn: boolean;
  /** The override the latest resolution started with. */
  overridePath: string | null;
}

const worktreeEnvs = new Map<string, WorktreeJavaEnv>();

/**
 * Keep the worktree's resolution memoized and watched while subscribed, and call `listener` after
 * each resolution finishes: the first one, and each re-resolution that a watched change, a new
 * override or a login-shell change causes (also when the result is the same JDK, since another JDK
 * may have appeared, which matters to whoever uses {@link listJavaRuntimes}). Subscribing resolves
 * nothing by itself; the first {@link getJavaEnv} does, so a worktree without Java costs nothing.
 * Returns the unsubscribe function; the memo goes with the last subscriber.
 */
export function subscribeJavaEnv(
  worktreePath: string,
  listener: (update: JavaEnvUpdate) => void,
): () => void {
  const wtPath = path.resolve(worktreePath);
  let entry = worktreeEnvs.get(wtPath);
  if (!entry) {
    entry = {
      listeners: new Set(),
      resolution: null,
      settled: null,
      withdrawn: false,
      overridePath: null,
    };
    worktreeEnvs.set(wtPath, entry);
  }
  const subscribed = entry;
  subscribed.listeners.add(listener);
  return () => {
    subscribed.listeners.delete(listener);
    if (subscribed.listeners.size > 0 || worktreeEnvs.get(wtPath) !== subscribed) return;
    worktreeEnvs.delete(wtPath);
    syncSharedWatch();
  };
}

/**
 * The worktree's JDK (see {@link resolveJavaEnv}), shared by every caller: memoized while the
 * worktree is subscribed, re-resolved when the watch reports a change, its override changes, or
 * the JDK turned out to be tracked by git since. Waits for a re-resolution in flight. Without a
 * subscriber it resolves afresh, since nothing would keep a memo current.
 */
export async function getJavaEnv(worktreePath: string): Promise<JavaEnv | null> {
  return (await getJavaEnvResolution(worktreePath)).env;
}

/** {@link getJavaEnv}, with what the resolution had to say about `JAVA_HOME`. */
export async function getJavaEnvResolution(worktreePath: string): Promise<JavaEnvResolution> {
  const wtPath = path.resolve(worktreePath);
  const entry = worktreeEnvs.get(wtPath);
  if (!entry) return resolveJavaEnv(wtPath);
  await revalidate(wtPath, entry);
  // Unsubscribed meanwhile: nothing would keep a watch armed for it now.
  if (worktreeEnvs.get(wtPath) !== entry) return resolveJavaEnv(wtPath);
  return entry.resolution ?? startResolution(wtPath, entry);
}

/** Re-resolve a subscribed worktree's JDK now, e.g. after its override changed. */
export function refreshJavaEnv(worktreePath: string): void {
  const wtPath = path.resolve(worktreePath);
  const entry = worktreeEnvs.get(wtPath);
  if (entry?.resolution) startResolution(wtPath, entry);
}

/** Login-shell variables that resolution reads. */
const RESOLUTION_ENV_VAR =
  /^(PATH|HOME|JAVA_HOME|SDKMAN_DIR|ASDF_DATA_DIR|MISE_DATA_DIR|XDG_DATA_HOME|GRADLE_USER_HOME)$/;

/**
 * Re-resolve every subscribed worktree that has resolved, e.g. after the login-shell environment
 * was captured again. With `changedNames`, only when one of them can change a resolution: some
 * startup files export values that differ on every run (session keys, agent sockets).
 */
export function refreshAllJavaEnvs(changedNames?: Iterable<string>): void {
  if (changedNames && !Array.from(changedNames).some((name) => RESOLUTION_ENV_VAR.test(name))) {
    return;
  }
  for (const [wtPath, entry] of worktreeEnvs) {
    if (entry.resolution) startResolution(wtPath, entry);
  }
}

/**
 * Start a re-resolution when the latest one no longer holds: the override was changed behind the
 * store's change hook, or the repository now tracks the settled JDK (the trust checks are cached
 * until a git index they read changes, so this is a few `stat` calls otherwise).
 */
async function revalidate(wtPath: string, entry: WorktreeJavaEnv): Promise<void> {
  if (!entry.resolution) return;
  if (getJavaOverride(wtPath) !== entry.overridePath) {
    startResolution(wtPath, entry);
    return;
  }
  const { settled } = entry;
  const settledEnv = settled?.resolution.env;
  if (!settledEnv || entry.withdrawn) return;
  if (!(await isJdkShippedByRepo(wtPath, settledEnv.path))) return;
  // Another caller may have noticed first, or the worktree was unsubscribed meanwhile.
  if (entry.settled !== settled || entry.withdrawn || worktreeEnvs.get(wtPath) !== entry) return;
  entry.withdrawn = true;
  startResolution(wtPath, entry);
}

function startResolution(wtPath: string, entry: WorktreeJavaEnv): Promise<JavaEnvResolution> {
  const overridePath = getJavaOverride(wtPath);
  const resolution = resolveJavaEnv(wtPath, { overridePath });
  entry.resolution = resolution;
  entry.overridePath = overridePath;
  // Watch the layout before the first resolution so nothing created meanwhile is missed.
  syncSharedWatch();
  void resolution.then((resolved) => {
    if (worktreeEnvs.get(wtPath) !== entry || entry.resolution !== resolution) return;
    const previous = entry.settled;
    entry.settled = { resolution: resolved, overridePath };
    entry.withdrawn = false;
    syncSharedWatch();
    const changed =
      !previous ||
      previous.overridePath !== overridePath ||
      previous.resolution.ignoredJavaHome !== resolved.ignoredJavaHome ||
      !isSameJavaEnv(previous.resolution.env, resolved.env);
    if (changed) {
      log.info("JDK resolved", {
        wtPath,
        source: resolved.env?.source ?? null,
        javaHome: resolved.env?.path ?? null,
      });
    }
    const update = { env: resolved.env, first: previous === null, changed };
    for (const listener of entry.listeners) {
      // One failing listener must not keep the update from the others.
      try {
        listener(update);
      } catch (err) {
        log.warn("A JDK listener failed", { wtPath, error: err });
      }
    }
  });
  return resolution;
}

/** Whether two resolutions found the same JDK, the same way. */
export function isSameJavaEnv(a: JavaEnv | null, b: JavaEnv | null): boolean {
  return (
    a?.source === b?.source &&
    a?.path === b?.path &&
    a?.version === b?.version &&
    a?.implementor === b?.implementor
  );
}

// ---------------------------------------------------------------------------
// Resolution

/**
 * Find the JDK for a worktree, first hit wins: the chosen override, `JAVA_HOME`, the newest JDK the
 * macOS `java_home` tool lists, the JDK of the first real `java` on the login-shell `PATH`, then
 * the newest JDK in the well-known install locations. Any candidate counts only when it is a
 * complete JDK ({@link readJdk}) and passes the trust rule ({@link isJdkShippedByRepo}). Never
 * throws and never runs anything from a JDK: the only process it starts itself is `java_home`.
 * Uncached; Loxel's features share {@link getJavaEnv} instead.
 */
export async function resolveJavaEnv(
  worktreePath: string,
  options: ResolveJavaEnvOptions = {},
): Promise<JavaEnvResolution> {
  const wtPath = path.resolve(worktreePath);
  try {
    const sources = jdkSources(wtPath, options);
    const overridePath =
      options.overridePath === undefined ? getJavaOverride(wtPath) : options.overridePath;
    const { runtime: fromJavaHome, ignoredJavaHome } = await sources.javaHome();
    const found = (env: JavaEnv | null) => ({ env, ignoredJavaHome });

    if (overridePath) {
      const override = await jdkAt(wtPath, overridePath);
      if (override) return found({ ...override, source: "override" });
    }
    if (fromJavaHome) return found({ ...fromJavaHome, source: "java-home" });
    for (const [source, lookup] of [
      ["java-home-tool", sources.javaHomeTool],
      ["path", sources.path],
      ["install-location", sources.installed],
    ] as const) {
      const [newest] = newestFirst(await lookup());
      if (newest) return found({ ...newest, source });
    }
    return found(null);
  } catch (err) {
    log.warn("JDK resolution failed", { wtPath, error: err });
    return { env: null, ignoredJavaHome: null };
  }
}

/**
 * Every JDK usable for a worktree, each once however many ways lead to it, newest first (so the
 * first of each `majorVersion` is the newest of that Java level). Includes the chosen override, and
 * JDKs automatic detection would not pick. Never throws.
 */
export async function listJavaRuntimes(
  worktreePath: string,
  options: ResolveJavaEnvOptions = {},
): Promise<JavaEnv[]> {
  const wtPath = path.resolve(worktreePath);
  try {
    const sources = jdkSources(wtPath, options);
    const overridePath =
      options.overridePath === undefined ? getJavaOverride(wtPath) : options.overridePath;
    const lookups = [
      ["override", async () => (overridePath ? [await jdkAt(wtPath, overridePath)] : [])],
      ["java-home", async () => [(await sources.javaHome()).runtime]],
      ["java-home-tool", sources.javaHomeTool],
      ["path", sources.path],
      ["install-location", sources.installed],
    ] as const;
    const found = await Promise.all(
      lookups.map(async ([source, lookup]) =>
        (await lookup()).flatMap((runtime): JavaEnv[] =>
          runtime ? [{ ...runtime, source: source satisfies JavaEnvSource }] : [],
        ),
      ),
    );
    const byRealPath = new Map<string, JavaEnv>();
    for (const runtime of found.flat()) {
      const real = await realpath(runtime.path).catch(() => runtime.path);
      if (!byRealPath.has(real)) byRealPath.set(real, runtime);
    }
    return newestFirst([...byRealPath.values()]);
  } catch (err) {
    log.warn("Listing JDKs failed", { wtPath, error: err });
    return [];
  }
}

/** Each way of finding JDKs for a worktree, under the options' defaults. */
function jdkSources(wtPath: string, options: ResolveJavaEnvOptions) {
  const env = options.env ?? buildSpawnEnv();
  const javaHomeTool =
    options.javaHomeTool === undefined
      ? process.platform === "darwin"
        ? MACOS_JAVA_HOME_TOOL
        : null
      : options.javaHomeTool;
  const roots = options.installRoots ?? javaInstallRoots(env);
  return {
    javaHome: () => javaHomeJdk(wtPath, env),
    javaHomeTool: () => javaHomeToolJdks(wtPath, javaHomeTool, env),
    path: () => pathJdks(wtPath, env),
    installed: () => installedJdks(wtPath, roots),
  };
}

/** The JDK at `JAVA_HOME`, or the value when it is set but unusable: it is often stale. */
async function javaHomeJdk(
  wtPath: string,
  env: SpawnEnv,
): Promise<{ runtime: JavaRuntime | null; ignoredJavaHome: string | null }> {
  const value = env.JAVA_HOME?.trim();
  if (!value) return { runtime: null, ignoredJavaHome: null };
  const runtime = await jdkAt(wtPath, value);
  return { runtime, ignoredJavaHome: runtime ? null : value };
}

async function javaHomeToolJdks(
  wtPath: string,
  tool: string | null,
  env: SpawnEnv,
): Promise<JavaRuntime[]> {
  if (!tool) return [];
  try {
    const proc = Bun.spawn([tool, "-V"], {
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: JAVA_HOME_TOOL_TIMEOUT_MS,
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const homes = parseJavaHomeList(`${stderr}\n${stdout}`);
    const found = await Promise.all(homes.map((home) => jdkAt(wtPath, home)));
    return found.filter((runtime) => runtime !== null);
  } catch (err) {
    log.debug("Asking java_home for its JDKs failed", { tool, error: err });
    return [];
  }
}

/**
 * The JDK homes in `java_home -V` output, whose lines read
 * `    21.0.5 (arm64) "Vendor" - "Name" /Library/.../Contents/Home`, with the default's bare path
 * after them. With no JDK it prints only an error message, which has no such lines.
 */
export function parseJavaHomeList(output: string): string[] {
  const homes = output
    .split("\n")
    .map((line) => (line.startsWith("/") ? line : line.match(/"\s+(\/.+)$/)?.[1])?.trim())
    .filter((home) => home !== undefined);
  return [...new Set(homes)];
}

/**
 * The JDK of the first real `java` on `PATH`, entry by entry, so a stub or a shim early on `PATH`
 * does not hide a real one later. Found by following symlinks to the file, never by running it; a
 * version manager's shim is a script outside any JDK, so it does not qualify.
 */
async function pathJdks(wtPath: string, env: SpawnEnv): Promise<JavaRuntime[]> {
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    const java = dir ? Bun.which(JAVA, { PATH: dir }) : null;
    if (!java) continue;
    const real = await realpath(java).catch(() => null);
    if (!real || isMacOsJavaStub(real) || (await isShippedByRepo(wtPath, java))) continue;
    const runtime = await jdkAt(wtPath, path.dirname(path.dirname(real)));
    if (runtime) return [runtime];
  }
  return [];
}

/**
 * The launcher macOS ships whether or not Java is installed. Running it may open a dialog offering
 * to install Java, so it is recognized by path and never run.
 */
export function isMacOsJavaStub(realJavaPath: string, platform = process.platform): boolean {
  return (
    platform === "darwin" &&
    (realJavaPath === "/usr/bin/java" ||
      realJavaPath.startsWith("/System/Library/Frameworks/JavaVM.framework/"))
  );
}

async function installedJdks(wtPath: string, roots: JavaInstallRoot[]): Promise<JavaRuntime[]> {
  const found = await Promise.all(
    roots.flatMap((root) =>
      rootEntries(root).map(async (entry) => {
        const runtime = await jdkAt(wtPath, entry);
        if (runtime || !root.nested) return [runtime];
        return Promise.all(subdirectories(entry).map((child) => jdkAt(wtPath, child)));
      }),
    ),
  );
  return found.flat().filter((runtime) => runtime !== null);
}

/** The directories of an install root; real ones first, so a `current` symlink loses to its target. */
function rootEntries({ dir, entryPrefix }: JavaInstallRoot): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const eligible = entries.filter(
    (entry) =>
      !entry.name.startsWith(".") &&
      (entry.isDirectory() || entry.isSymbolicLink()) &&
      (!entryPrefix || entry.name.startsWith(entryPrefix)),
  );
  return eligible
    .toSorted(
      (a, b) =>
        Number(a.isSymbolicLink()) - Number(b.isSymbolicLink()) || a.name.localeCompare(b.name),
    )
    .map((entry) => path.join(dir, entry.name));
}

function subdirectories(dir: string): string[] {
  return rootEntries({ dir }).filter(isDirectory);
}

/**
 * Newest version first; ties keep their order, so the earlier install location wins. The Java level
 * compares first, then every other number in the version. Picking the newest needs no configuration,
 * matches `java_home`'s own default, and is what compiles every project a JDK here can compile.
 */
function newestFirst<T extends JavaRuntime>(runtimes: T[]): T[] {
  const numbers = (version: string) => (version.match(/\d+/g) ?? []).map(Number);
  return runtimes.toSorted((a, b) => {
    if (a.majorVersion !== b.majorVersion) return b.majorVersion - a.majorVersion;
    const [aParts, bParts] = [numbers(a.version), numbers(b.version)];
    for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
      const difference = (bParts[i] ?? 0) - (aParts[i] ?? 0);
      if (difference !== 0) return difference;
    }
    return 0;
  });
}

/**
 * Check a JDK the user entered for a worktree and return its home directory. Accepts `~/` paths, a
 * `.jdk` bundle, a Homebrew `opt` directory and the path of its `bin/java`. Throws an error meant
 * for the user when it is not a complete JDK or the repository tracks any of it.
 */
export async function normalizeJavaOverride(worktreePath: string, input: string): Promise<string> {
  const wtPath = path.resolve(worktreePath);
  const trimmed = input.trim();
  const expanded =
    trimmed === "~" || trimmed.startsWith("~/") ? path.join(homedir(), trimmed.slice(1)) : trimmed;
  if (!path.isAbsolute(expanded)) throw new Error("Enter an absolute path to a JDK");
  const target = path.resolve(expanded);
  const isJavaFile = path.basename(target) === JAVA && !isDirectory(target);
  const dir = isJavaFile ? path.dirname(path.dirname(target)) : target;
  const found = await findJdk(dir);
  if (!found) {
    throw new Error(`No JDK at ${target}; enter the home directory of a JDK, not of a JRE`);
  }
  if (await isJdkShippedByRepo(wtPath, found.path, dir)) {
    throw new Error("Loxel does not use a JDK that the repository tracks in git");
  }
  return found.path;
}

// ---------------------------------------------------------------------------
// Reading a JDK

/** The path of a JDK's `java` executable, for whoever runs it. */
export function javaExecutable(javaHome: string): string {
  return path.join(javaHome, "bin", JAVA);
}

/** Where the home of a JDK at `dir` can be: itself, a macOS bundle, or Homebrew's `opt` directory. */
function jdkHomeCandidates(dir: string): string[] {
  const bundleHome = path.join("Contents", "Home");
  return [
    dir,
    path.join(dir, bundleHome),
    path.join(dir, "libexec", "openjdk.jdk", bundleHome),
    path.join(dir, "libexec"),
  ];
}

/** The JDK at `dir`, held to the trust rule, or null. `dir` must be absolute. */
async function jdkAt(wtPath: string, dir: string): Promise<JavaRuntime | null> {
  // A relative path would be read against the server's directory; `JAVA_HOME` must be absolute too.
  if (!path.isAbsolute(dir)) return null;
  const resolved = path.resolve(dir);
  const found = await findJdk(resolved);
  if (!found) return null;
  if (await isJdkShippedByRepo(wtPath, found.path, resolved)) {
    log.warn("Ignoring a JDK with files tracked by git", { wtPath, javaHome: found.path });
    return null;
  }
  return found;
}

async function findJdk(dir: string): Promise<JavaRuntime | null> {
  for (const home of jdkHomeCandidates(dir)) {
    const runtime = await readJdk(home);
    if (runtime) return runtime;
  }
  return null;
}

/**
 * The JDK whose home is `home`, read without running anything. A JDK has `bin/java`, `bin/javac`,
 * class data to compile against (`lib/ct.sym` in every JDK; `jmods` too, except in builds since JDK
 * 24 that leave it out) and a `release` file naming its version. A JRE or a `jlink` runtime has no `javac` or
 * `ct.sym`, and a `java` wrapper script or a stub has no `release`.
 */
async function readJdk(home: string): Promise<JavaRuntime | null> {
  const bin = path.join(home, "bin");
  if (!(await isExecutableFile(path.join(bin, JAVA)))) return null;
  if (!(await isExecutableFile(path.join(bin, JAVAC)))) return null;
  const hasClassData =
    isDirectory(path.join(home, "jmods")) ||
    (await Bun.file(path.join(home, "lib", "ct.sym")).exists());
  if (!hasClassData) return null;

  let release: Map<string, string>;
  try {
    const releasePath = path.join(home, "release");
    // Before the trust rule, so a pipe in a repository must not be able to hang resolution.
    if (!(await stat(releasePath)).isFile()) return null;
    const file = Bun.file(releasePath);
    release = parseReleaseFile(await file.slice(0, RELEASE_FILE_MAX_BYTES).text());
  } catch {
    return null;
  }
  const version = release.get("JAVA_VERSION");
  const majorVersion = version ? javaMajorVersion(version) : null;
  if (!version || majorVersion === null) return null;
  return { path: home, majorVersion, version, implementor: release.get("IMPLEMENTOR") || null };
}

/** The `KEY="value"` lines of a JDK's `release` file. */
export function parseReleaseFile(content: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of content.split("\n")) {
    const match = line.match(/^([A-Z_]+)=(?:"(.*)"|(.*))\s*$/);
    if (match) values.set(match[1]!, (match[2] ?? match[3] ?? "").trim());
  }
  return values;
}

/** The Java level of a version: `21.0.5` and `21-ea` are 21, and the old-style `1.8.0_392` is 8. */
export function javaMajorVersion(version: string): number | null {
  const match = version.match(/^(\d+)(?:\.(\d+))?/);
  if (!match) return null;
  const major = Number(match[1]);
  if (major !== 1) return major;
  return match[2] ? Number(match[2]) : null;
}

async function isExecutableFile(filePath: string): Promise<boolean> {
  try {
    // Follows symlinks, so a link into a removed JDK does not count.
    await access(filePath, constants.X_OK);
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

/**
 * The environment trust rule of `shipped-by-repo.ts`, for the JDK at `home`: refused when git tracks any
 * file in it, or its `java`, or what that resolves to. Also refused when the home is the worktree
 * or holds it: the rule then looks only at a Python environment's own entries, and a JDK that shares
 * a directory with the repository would load the repository's files. `dir` is the path it was found
 * through, which a committed symlink can be when the home lies further inside (`Contents/Home`).
 */
async function isJdkShippedByRepo(wtPath: string, home: string, dir = home): Promise<boolean> {
  const realOrSelf = (target: string) => realpath(target).catch(() => target);
  const [realWtPath, realHome] = await Promise.all([realOrSelf(wtPath), realOrSelf(home)]);
  const fromHome = path.relative(realHome, realWtPath);
  if (!path.isAbsolute(fromHome) && fromHome.split(path.sep)[0] !== "..") return true;
  if (dir !== home && (await isShippedByRepo(wtPath, dir))) return true;
  return isEnvShippedByRepo(wtPath, home, javaExecutable(home));
}

// ---------------------------------------------------------------------------
// Watching

/** A live {@link watchJavaEnv} watch. */
export interface JavaEnvWatch {
  close(): void;
  /** True when a change was seen whose debounced `onChange` has not fired yet. */
  readonly hasPendingChange: boolean;
  /** Report a change seen elsewhere, through the same debounce. */
  nudge(): void;
}

/** Directories to watch, each with the entry names that matter there (null = every entry). */
type WatchTargets = Map<string, Set<string> | null>;

/** The one watch of the machine's JDKs, shared by every worktree that has resolved. */
let sharedWatch: { key: string; watch: JavaEnvWatch } | null = null;

/** Bring the shared watch in line with what the resolved worktrees depend on. */
function syncSharedWatch(): void {
  const resolved = [...worktreeEnvs.values()].filter((entry) => entry.resolution);
  if (resolved.length === 0) {
    sharedWatch?.watch.close();
    sharedWatch = null;
    return;
  }
  const env = buildSpawnEnv();
  const homes = resolved.flatMap((entry) => [
    ...(entry.overridePath ? [entry.overridePath] : []),
    ...(entry.settled?.resolution.env ? [entry.settled.resolution.env.path] : []),
  ]);
  const targets = javaWatchTargets(javaInstallRoots(env), [
    ...homes,
    ...(env.JAVA_HOME ? [env.JAVA_HOME] : []),
  ]);
  const key = [...targets]
    .map(([dir, names]) => [dir, ...(names ? [...names].toSorted() : [])].join("\0"))
    .toSorted()
    .join("\n");
  if (sharedWatch?.key === key) return;
  // A platform watch may start a moment after it is created, so the old one overlaps it; what the
  // old one saw last goes through the new one's debounce, so a write burst coalesces.
  const old = sharedWatch?.watch;
  sharedWatch = { key, watch: watchJavaEnv(targets, () => refreshAllJavaEnvs()) };
  if (!old) return;
  setTimeout(() => {
    if (old.hasPendingChange) sharedWatch?.watch.nudge();
    old.close();
  }, WATCH_OVERLAP_MS).unref();
}

/**
 * What to watch: each install root (or, when missing, its deepest existing ancestor for the next
 * path segment), an entry of a root that is not a complete JDK yet (an installer may still be
 * filling it, which the root's own watch does not report), and each of `homes` being removed,
 * replaced or created.
 */
export function javaWatchTargets(roots: JavaInstallRoot[], homes: string[]): WatchTargets {
  const targets: WatchTargets = new Map();
  const add = (dir: string, name: string | null) => {
    const names = targets.get(dir);
    if (names === null) return;
    if (name === null) targets.set(dir, null);
    else if (names) names.add(name);
    else targets.set(dir, new Set([name]));
  };
  const addAppearance = (target: string) => {
    let missing = target;
    while (!isDirectory(path.dirname(missing)) && path.dirname(missing) !== missing) {
      missing = path.dirname(missing);
    }
    const parent = path.dirname(missing);
    // Everything on the disk is below a filesystem root, so it is not worth watching.
    if (path.dirname(parent) !== parent) add(parent, path.basename(missing));
  };
  const addIncomplete = (dir: string) => {
    const homes = jdkHomeCandidates(dir);
    if (homes.some(hasJdkFiles)) return;
    for (const home of homes.flatMap((h) => [h, path.join(h, "bin"), path.join(h, "lib")])) {
      if (isDirectory(home)) add(home, null);
    }
  };

  for (const root of roots) {
    if (!isDirectory(root.dir)) {
      addAppearance(root.dir);
      continue;
    }
    add(root.dir, null);
    for (const entry of rootEntries(root)) {
      addIncomplete(entry);
      if (root.nested) subdirectories(entry).forEach(addIncomplete);
    }
  }
  for (const home of homes) {
    if (!path.isAbsolute(home)) continue;
    const resolved = path.resolve(home);
    addAppearance(resolved);
    if (isDirectory(resolved)) {
      add(resolved, "release");
      add(resolved, "bin");
    }
  }
  return targets;
}

/** Whether a home has every file {@link readJdk} needs, so nothing more is on its way. */
function hasJdkFiles(home: string): boolean {
  return (
    existsSync(path.join(home, "release")) &&
    existsSync(path.join(home, "bin", JAVA)) &&
    existsSync(path.join(home, "bin", JAVAC)) &&
    (existsSync(path.join(home, "jmods")) || existsSync(path.join(home, "lib", "ct.sym")))
  );
}

/**
 * Call `onChange` (debounced) when something in `targets` changes. Watches are non-recursive and
 * fixed to the layout seen now, so callers re-resolve and re-watch on every change.
 */
export function watchJavaEnv(targets: WatchTargets, onChange: () => void): JavaEnvWatch {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onChange();
    }, WATCH_DEBOUNCE_MS);
  };

  const watchers: FSWatcher[] = [];
  for (const [dir, names] of targets) {
    try {
      const watcher = watch(dir, (_event, filename) => {
        // A null filename means the platform could not say what changed; treat it as relevant.
        if (names === null || filename === null || names.has(filename)) schedule();
      });
      watcher.on("error", (err) => log.debug("JDK watch failed", { dir, error: err }));
      watchers.push(watcher);
    } catch (err) {
      log.debug("Could not watch for JDK changes", { dir, error: err });
    }
  }

  return {
    close() {
      if (timer) clearTimeout(timer);
      timer = null;
      for (const watcher of watchers) watcher.close();
    },
    get hasPendingChange() {
      return timer !== null;
    },
    nudge: schedule,
  };
}
