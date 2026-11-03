import { createHash } from "node:crypto";
import { existsSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

import type { JavaProjectIssue } from "@/api/java-env-model";
import { isRecord } from "@/lib/is-record";

import { readConfigFile } from "./config-file-read";
import { logger } from "./logger";
import { isInside } from "./path-containment";

/**
 * Loading Maven and Gradle projects in a trusted repository: which projects can load from what is
 * on this machine, the settings and process options that keep it to that, and what the server says
 * about how it went. Nothing here runs anything from a project or fetches anything. See
 * `docs/languages/java.md`.
 */

const MAVEN_BUILD_FILE = "pom.xml";
const GRADLE_BUILD_FILES = new Set([
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
]);
const WRAPPER_PROPERTIES = path.join("gradle", "wrapper", "gradle-wrapper.properties");

/** jdtls's own defaults, which `java.import.exclusions` replaces. */
const DEFAULT_IMPORT_EXCLUSIONS = [
  "**/node_modules/**",
  "**/.metadata/**",
  "**/archetype-resources/**",
  "**/META-INF/maven/**",
];

/** Directories that never hold a project of the worktree or its source files. */
export const NOT_PROJECT_DIRS = new Set(["node_modules", "build", "target", "out", "bin"]);
/** Where looking through a worktree stops, in a very large repository. */
export const MAX_SCANNED_DIRS = 20_000;

/** How long a Gradle daemon the server started stays once idle, should it outlive the server. */
const GRADLE_DAEMON_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
/** Gradle's event for a project whose Gradle cannot run on the JDK it was given. */
const INCOMPATIBLE_GRADLE_EVENT = 300;
const ERROR_SEVERITY = 1;
/** How a build file's marker says a dependency or plugin isn't on this machine. */
const MISSING_DEPENDENCY =
  /Missing artifact|could not be resolved|Unresolved dependency|Could not resolve|Non-resolvable|Unresolveable/;

/** The build files of a worktree, found by name without reading or running them. */
export interface BuildProjects {
  /** Every directory holding a build file. */
  dirs: string[];
  hasMaven: boolean;
  /** The topmost directories holding a Gradle build file: what jdtls imports as Gradle roots. */
  gradleRoots: string[];
}

/** Whether a changed file can change which projects there are or what they need to load. */
export function isProjectFile(file: string): boolean {
  const name = path.basename(file);
  return (
    name === MAVEN_BUILD_FILE || GRADLE_BUILD_FILES.has(name) || file.endsWith(WRAPPER_PROPERTIES)
  );
}

export async function findBuildProjects(wtPath: string): Promise<BuildProjects> {
  const found: BuildProjects = { dirs: [], hasMaven: false, gradleRoots: [] };
  const queue: { dir: string; underGradle: boolean }[] = [{ dir: wtPath, underGradle: false }];
  for (let i = 0; i < queue.length && i < MAX_SCANNED_DIRS; i++) {
    const { dir, underGradle } = queue[i] ?? { dir: wtPath, underGradle: false };
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
    const maven = files.includes(MAVEN_BUILD_FILE);
    const gradle = files.some((name) => GRADLE_BUILD_FILES.has(name));
    if (maven || gradle) found.dirs.push(dir);
    found.hasMaven ||= maven;
    if (gradle && !underGradle) found.gradleRoots.push(dir);
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || NOT_PROJECT_DIRS.has(entry.name))
        continue;
      queue.push({ dir: path.join(dir, entry.name), underGradle: underGradle || gradle });
    }
  }
  return found;
}

/** What Gradle would need to fetch to start in `root`, from its wrapper properties. */
export interface WrapperDistribution {
  /** The directory name of the distribution, such as `gradle-9.5.1-bin`. */
  name: string;
  /** Whether the wrapper has it installed, so that running it fetches nothing. */
  installed: boolean;
}

/** A value of a `.properties` file, with its backslash escapes undone. */
function propertyValue(text: string, key: string): string | null {
  const line = new RegExp(`^[^\\S\\n]*${key}[^\\S\\n]*[=:][^\\S\\n]*(.*?)\\s*$`, "m").exec(text);
  return line?.[1] ? line[1].replace(/\\(.)/g, "$1") : null;
}

/** The directory the wrapper installs `url` in, as its `PathAssembler` names it. */
function wrapperHash(url: string): string {
  const digest = createHash("md5").update(url).digest("hex");
  return BigInt(`0x${digest}`).toString(36);
}

/**
 * The distribution of the wrapper in `root`, or null when it has none. It counts as installed once
 * the wrapper's own `.ok` marker is there. A relative URL is a file next to the properties file.
 */
export function wrapperDistribution(
  root: string,
  env: Record<string, string | undefined>,
): WrapperDistribution | null {
  const file = path.join(root, WRAPPER_PROPERTIES);
  const text = readConfigFile(file);
  if (text === undefined) return null;
  const raw = propertyValue(text, "distributionUrl");
  if (!raw) return { name: "Gradle", installed: false };
  // As the wrapper's `Download.safeUri` and `File.toURI` give it: no credentials, spaces encoded.
  const url = /^[a-z][a-z0-9+.-]*:/i.test(raw)
    ? raw.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, "$1")
    : `file:${encodeURI(path.resolve(path.dirname(file), raw))}`;
  const urlPath = url.replace(/[?#].*$/, "");
  const zip = decodeURIComponent(urlPath.slice(urlPath.lastIndexOf("/") + 1));
  const name = zip.replace(/\.[^.]*$/, "");
  // The marker sits next to the downloaded archive, which has its own location settings.
  const base =
    propertyValue(text, "zipStoreBase") === "PROJECT"
      ? root
      : (env.GRADLE_USER_HOME ?? path.join(env.HOME ?? "", ".gradle"));
  const dists = propertyValue(text, "zipStorePath") ?? path.join("wrapper", "dists");
  const marker = path.join(base, dists, name, wrapperHash(url), `${zip}.ok`);
  return { name, installed: existsSync(marker) };
}

function realPathOf(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

/** Whether `dir` is a Gradle installation, not a script or a version manager's shim. */
function isGradleInstallation(dir: string): boolean {
  try {
    return readdirSync(path.join(dir, "lib")).some((name) => name.startsWith("gradle-launcher-"));
  } catch {
    return false;
  }
}

/**
 * The user's own Gradle, for a project without a wrapper: `GRADLE_HOME`, or the installation of the
 * first `gradle` on `PATH` (Homebrew keeps it under `libexec`). One inside the worktree does not
 * count. Nothing is run to find it.
 */
export function localGradleHome(
  wtPath: string,
  env: Record<string, string | undefined>,
): string | null {
  const candidates: string[] = env.GRADLE_HOME ? [env.GRADLE_HOME] : [];
  for (const dir of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const gradle = path.join(dir, "gradle");
    if (!existsSync(gradle)) continue;
    const home = path.dirname(path.dirname(realPathOf(gradle)));
    candidates.push(home, path.join(home, "libexec"));
    break;
  }
  const real = realPathOf(wtPath);
  return (
    candidates.find((home) => {
      if (!isGradleInstallation(home)) return false;
      return !isInside(realPathOf(home), real);
    }) ?? null
  );
}

/** What can be imported in a worktree right now. */
export interface ImportPlan {
  projects: BuildProjects;
  /** Gradle roots that cannot load from what is on this machine, with what to do about each. */
  blocked: { root: string; message: string }[];
  gradleHome: string | null;
  /** What fetches a Gradle project's dependencies: null with no Gradle project that can run. */
  gradleCommand: string | null;
}

export function planImport(
  wtPath: string,
  projects: BuildProjects,
  env: Record<string, string | undefined>,
): ImportPlan {
  const blocked: ImportPlan["blocked"] = [];
  const gradleHome = localGradleHome(wtPath, env);
  for (const root of projects.gradleRoots) {
    const where = path.relative(wtPath, root);
    const inFolder = where ? ` in ${where}` : "";
    const distribution = wrapperDistribution(root, env);
    if (distribution === null) {
      if (gradleHome === null) {
        blocked.push({
          root,
          message: `The Gradle project${inFolder} has no wrapper, and no Gradle is installed. Install Gradle.`,
        });
      }
      continue;
    }
    if (!distribution.installed) {
      blocked.push({
        root,
        message: `${distribution.name} isn't installed. Run ./gradlew once${inFolder} in a terminal.`,
      });
    }
  }
  const held = new Set(blocked.map(({ root }) => root));
  const runnable = projects.gradleRoots.filter((root) => !held.has(root));
  const first = runnable[0];
  const where =
    first && first !== wtPath && runnable.length === 1 ? path.relative(wtPath, first) : "";
  const tool = first && wrapperDistribution(first, env) === null ? "gradle" : "./gradlew";
  const gradleCommand = first ? `${tool} testClasses${where ? ` in ${where}` : ""}` : null;
  return { projects, blocked, gradleHome, gradleCommand };
}

/** A path as a literal part of the glob `java.import.exclusions` takes. */
function escapeGlob(dir: string): string {
  return dir.replace(/[\\*?[\]{}]/g, "\\$&");
}

/** One entry of `java.configuration.runtimes`, as far as import reads it. */
interface ImportRuntime {
  path: string;
  default?: true;
}

/** The import settings of a trusted repository. Downloads stay off: see the module comment. */
export function trustedImportSettings(
  wtPath: string,
  plan: ImportPlan,
  runtimes: readonly ImportRuntime[],
): Record<string, unknown> {
  const chosen = runtimes.find((runtime) => runtime.default)?.path;
  const blockedRoots = plan.blocked.map(({ root }) => root);
  const installations = runtimes.map((runtime) => runtime.path).filter((p) => !p.includes(","));
  return {
    import: {
      maven: { enabled: true, offline: { enabled: true } },
      gradle: {
        // An exclusion cannot name the folder the server is rooted at.
        enabled: !blockedRoots.includes(wtPath),
        offline: { enabled: true },
        wrapper: { enabled: true },
        ...(plan.gradleHome ? { home: plan.gradleHome } : {}),
        ...(chosen ? { java: { home: chosen } } : {}),
        arguments: [
          `-Porg.gradle.java.installations.paths=${installations.join(",")}`,
          "-Porg.gradle.java.installations.auto-download=false",
        ],
      },
      exclusions: [
        ...DEFAULT_IMPORT_EXCLUSIONS,
        ...blockedRoots
          .filter((root) => root !== wtPath)
          .flatMap((root) => [escapeGlob(root), `${escapeGlob(root)}/**`]),
      ],
    },
    autobuild: { enabled: true },
    maven: { downloadSources: false, updateSnapshots: false },
    eclipse: { downloadSources: false },
    configuration: { updateBuildConfiguration: "automatic" },
  };
}

/**
 * Options for every JVM under the server, Gradle's daemons included, which is why they travel in
 * the environment rather than on the server's command line: no host name resolves but localhost,
 * and HTTP has no way out.
 */
export function importJavaToolOptions(hostsFile: string): string {
  return [
    `-Djdk.net.hosts.file="${hostsFile}"`,
    "-Dhttp.proxyHost=127.0.0.1",
    "-Dhttp.proxyPort=9",
    "-Dhttps.proxyHost=127.0.0.1",
    "-Dhttps.proxyPort=9",
  ].join(" ");
}

/**
 * Flags for the server's JVM, which runs Gradle's client: its daemons register in `daemonDir`, apart
 * from the user's, so neither reuses the other's, and they leave by themselves when idle.
 */
export function gradleClientFlags(daemonDir: string): string[] {
  return [
    `-Dorg.gradle.daemon.registry.base=${daemonDir}`,
    `-Dorg.gradle.daemon.idletimeout=${GRADLE_DAEMON_IDLE_TIMEOUT_MS}`,
  ];
}

const DAEMON_LOG = /^daemon-(\d+)\.out\.log$/;

/** The daemons registered in `daemonDir`, from the logs Gradle names by their process ids. */
export function registeredDaemons(daemonDir: string): { pid: number; log: string }[] {
  const versions = readdirSync(daemonDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  return versions.flatMap(({ name }) =>
    readdirSync(path.join(daemonDir, name)).flatMap((file) => {
      const pid = DAEMON_LOG.exec(file)?.[1];
      return pid ? [{ pid: Number(pid), log: path.join(daemonDir, name, file) }] : [];
    }),
  );
}

/** Whether `pid` has the log open, which only the daemon the log was named for does. */
async function holdsLog(pid: number, log: string): Promise<boolean> {
  const open = await Bun.$`lsof -a -p ${pid} -Fn`.nothrow().quiet().text();
  return open.split("\n").includes(`n${log}`);
}

/**
 * Stop the daemons a closed server started, and only those, then forget their registry. The id in
 * a log's name may have gone to another process since. Without `lsof`, as on Windows, nothing
 * stops here and the idle timeout ends the daemon.
 */
export async function stopGradleDaemons(daemonDir: string): Promise<void> {
  if (!existsSync(daemonDir)) return;
  const real = realpathSync(daemonDir);
  for (const { pid, log } of registeredDaemons(real)) {
    try {
      if (await holdsLog(pid, log)) process.kill(pid, "SIGTERM");
    } catch (err) {
      logger.child("java-lsp").debug("Stopping a Gradle daemon failed", { pid, error: err });
    }
  }
  rmSync(daemonDir, { recursive: true, force: true });
}

/** What a frame from the server says about how the import went. */
export type ImportSignal =
  | { kind: "status"; ok: boolean }
  | { kind: "incompatible"; message: string }
  | { kind: "build-file"; uri: string; error: string | null };

/** Whether a frame may carry an {@link ImportSignal}; most frames are not worth parsing. */
export function mayCarryImportSignal(body: string): boolean {
  return (
    body.includes('"language/status"') ||
    body.includes('"language/eventNotification"') ||
    (body.includes('"textDocument/publishDiagnostics"') && !/"uri":"[^"]*\.java"/.test(body))
  );
}

/** The line of a marker worth showing: what is missing, in one Gradle wraps in several lines. */
function summaryLine(text: string): string {
  const lines = text.split("\n");
  return lines.find((line) => MISSING_DEPENDENCY.test(line))?.trim() ?? lines[0] ?? text;
}

export function importSignal(message: Record<string, unknown>): ImportSignal | null {
  const { method, params } = message;
  if (!isRecord(params)) return null;
  if (method === "language/status") {
    if (params.type !== "ProjectStatus") return null;
    return { kind: "status", ok: params.message === "OK" };
  }
  if (method === "language/eventNotification") {
    if (params.eventType !== INCOMPATIBLE_GRADLE_EVENT || !isRecord(params.data)) return null;
    const text = params.data.message;
    return typeof text === "string" ? { kind: "incompatible", message: text } : null;
  }
  if (method !== "textDocument/publishDiagnostics") return null;
  const { uri, diagnostics } = params;
  if (typeof uri !== "string" || uri.endsWith(".java") || !Array.isArray(diagnostics)) return null;
  const error = diagnostics.find(
    (d: unknown) => isRecord(d) && d.severity === ERROR_SEVERITY && typeof d.message === "string",
  );
  return {
    kind: "build-file",
    uri,
    error: isRecord(error) ? summaryLine(String(error.message)) : null,
  };
}

/** What the server has reported about a worktree's import so far. */
export interface ImportState {
  statusOk: boolean | null;
  incompatible: string | null;
  buildFileErrors: Map<string, string>;
}

export function applyImportSignal(state: ImportState, signal: ImportSignal): void {
  if (signal.kind === "status") {
    state.statusOk = signal.ok;
  } else if (signal.kind === "incompatible") {
    state.incompatible = signal.message;
  } else if (signal.error === null) {
    state.buildFileErrors.delete(signal.uri);
  } else {
    state.buildFileErrors.set(signal.uri, signal.error);
  }
}

/** What to tell the user about a worktree's projects: null while nothing is wrong. */
export function projectIssue(plan: ImportPlan, state: ImportState): JavaProjectIssue | null {
  const lines = plan.blocked.map(({ message }) => message);
  if (state.incompatible) {
    lines.push(`${state.incompatible} Choose a JDK it can run on.`);
  }
  const errors = [...state.buildFileErrors.values()];
  const missing = errors.find((error) => MISSING_DEPENDENCY.test(error));
  if (missing || (state.statusOk === false && !state.incompatible)) {
    const reason = missing ?? errors[0];
    const commands = [
      ...(plan.projects.hasMaven ? ["mvn test-compile"] : []),
      ...(plan.gradleCommand ? [plan.gradleCommand] : []),
    ].join(" or ");
    if (reason) lines.push(reason);
    if (commands) lines.push(`Fetch what's missing with ${commands} in a terminal.`);
  }
  if (lines.length === 0) return null;
  return { label: "Project not fully loaded", detail: [...lines, "Click to reload."].join("\n") };
}

const issues = new Map<string, JavaProjectIssue>();
const issueListeners = new Set<(wtPath: string) => void>();
const reloadListeners = new Set<(wtPath: string) => void>();

export function getJavaProjectIssue(wtPath: string): JavaProjectIssue | null {
  return issues.get(wtPath) ?? null;
}

export function setJavaProjectIssue(wtPath: string, issue: JavaProjectIssue | null): void {
  const previous = issues.get(wtPath) ?? null;
  if (previous?.detail === issue?.detail) return;
  if (issue) issues.set(wtPath, issue);
  else issues.delete(wtPath);
  for (const listener of issueListeners) listener(wtPath);
}

export function onJavaProjectIssueChange(listener: (wtPath: string) => void): () => void {
  issueListeners.add(listener);
  return () => issueListeners.delete(listener);
}

/** Load a worktree's projects again, after the user ran what the note asked for. */
export function reloadJavaProjects(wtPath: string): void {
  for (const listener of reloadListeners) listener(wtPath);
}

export function onJavaProjectsReload(listener: (wtPath: string) => void): () => void {
  reloadListeners.add(listener);
  return () => reloadListeners.delete(listener);
}
