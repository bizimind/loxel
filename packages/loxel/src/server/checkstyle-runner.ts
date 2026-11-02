/**
 * Running the machine's `checkstyle` on saved files, and reading what it reports. It has no stdin
 * mode and no long-lived mode, so each run is a JVM start on files from disk.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { CheckstyleProject } from "./checkstyle-config";
import { isVersionManagerShim as isInShimsDir } from "./csharp-env";
import { killProcessGroup } from "./formatter-backends";
import { isJdkInWorktree, listJavaRuntimes } from "./java-env";
import { importJavaToolOptions } from "./java-project-import";
import { jdkToolEnv, NO_JAVA, trustedPath } from "./kotlin-formatter";
import { logger } from "./logger";
import { linksToVersionManager } from "./rust-tool-shim";
import { buildSpawnEnv } from "./shell-env";

const log = logger.child("checkstyle-lsp");

const COMMAND = "checkstyle";
/** A JVM may be slow on a busy machine; past this something is wrong, and a later save tries again. */
const RUN_TIMEOUT_MS = 60_000;
const VERSION_TIMEOUT_MS = 15_000;
/** A failure notice longer than this is cut; the log has all of it. */
const MAX_FAILURE_LENGTH = 600;
/** Checkstyle's default, which its `column` counts a tab as, up to the next multiple. */
const DEFAULT_TAB_WIDTH = 8;
/** What `google_checks.xml`, inside the jar, sets. */
const BUNDLED_TAB_WIDTH: Record<string, number> = { "google_checks.xml": 2 };
/** A short-lived JVM: these take a fifth off every run. */
const JVM_FLAGS = ["-XX:TieredStopAtLevel=1", "-XX:+UseSerialGC", "-Xshare:auto"];
/** Beyond what project import's options cover, for the URL schemes and sockets those don't. */
const MORE_DEAD_ENDS = [
  "-Dftp.proxyHost=127.0.0.1",
  "-Dftp.proxyPort=9",
  "-DsocksProxyHost=127.0.0.1",
  "-DsocksProxyPort=9",
];

const CHECKS_PACKAGE = "com.puppycrawl.tools.checkstyle.checks.";
const CHECK_DOCS = "https://checkstyle.org/checks";
/** Checks in these packages have their page under `misc`. */
const DOCS_MISC_GROUPS = new Set(["", "indentation"]);

const SEVERITY = { error: 1, warning: 2, info: 3 } as const;

export interface CheckstyleDiagnostic {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  severity: (typeof SEVERITY)[keyof typeof SEVERITY];
  source: "checkstyle";
  message: string;
  code?: string;
  codeDescription?: { href: string };
}

export type CheckstyleOutcome =
  /** Diagnostics by file; a file that was checked and has none is absent. */
  | { kind: "reported"; diagnostics: Map<string, CheckstyleDiagnostic[]> }
  | { kind: "not-installed" }
  /** Only a version manager's shim is on `PATH`, which isn't run. */
  | { kind: "shim-only" }
  | { kind: "no-java" }
  /** The newest JDK on the machine is older than this Checkstyle needs. */
  | { kind: "needs-newer-java" }
  /** The config didn't load, so nothing was checked. */
  | { kind: "config-failed"; message: string }
  /** A run went wrong in a way a later save may not: a timeout, a JVM that died. */
  | { kind: "failed"; message: string }
  | { kind: "stopped" };

/** The machine's `checkstyle`, never one from the worktree or a version manager's shim. */
export async function findCheckstyle(
  wtPath: string,
): Promise<{ executable: string; path: string } | { sawShim: boolean }> {
  const root = path.resolve(wtPath);
  const searchPath = await trustedPath(COMMAND, root);
  let sawShim = false;
  for (const dir of searchPath.split(path.delimiter)) {
    const found = dir ? Bun.which(COMMAND, { PATH: dir }) : null;
    if (!found) continue;
    if ((await isInShimsDir(found)) || (await linksToVersionManager(found))) sawShim = true;
    else return { executable: found, path: searchPath };
  }
  return { sawShim };
}

/**
 * Check `files` of `project`. A file that doesn't parse stops the run, with no way to go on past it,
 * so the files after it get a run of their own; jdtls reports the syntax error.
 */
export async function runCheckstyle(
  project: CheckstyleProject,
  files: readonly string[],
  wtPath: string,
  signal: AbortSignal,
): Promise<CheckstyleOutcome> {
  const tool = await findCheckstyle(wtPath);
  if (!("executable" in tool)) {
    return tool.sawShim ? { kind: "shim-only" } : { kind: "not-installed" };
  }
  const scratch = await mkdtemp(path.join(tmpdir(), "loxel-checkstyle-"));
  try {
    const prepared = await prepareRun(project, tool, wtPath, scratch);
    if ("message" in prepared) return { kind: "config-failed", message: prepared.message };
    const diagnostics = new Map<string, CheckstyleDiagnostic[]>();
    let remaining = [...files];
    while (remaining.length > 0) {
      const exit = await spawnCheckstyle(
        tool.executable,
        [...prepared.args, ...remaining],
        prepared.env,
        scratch,
        signal,
      );
      if (signal.aborted) return { kind: "stopped" };
      if (exit.timedOut) {
        return { kind: "failed", message: `it did not finish in ${RUN_TIMEOUT_MS / 1_000} s.` };
      }
      if (NO_JAVA.test(exit.stderr)) return { kind: "no-java" };
      if (exit.stderr.includes("UnsupportedClassVersionError")) return { kind: "needs-newer-java" };
      const report = parseCheckstyleXml(exit.stdout, remaining);
      if (!report) return { kind: "config-failed", message: failureMessage(exit) };
      for (const [file, errors] of report.errors) {
        const list = await toDiagnostics(file, errors, prepared.tabWidth);
        if (list.length > 0) diagnostics.set(file, list);
      }
      const stoppedAt = stoppedAtFile(exit.stderr, remaining);
      if (stoppedAt === null) break;
      log.debug("Checkstyle could not process a file", { file: stoppedAt });
      remaining = remaining.filter((file) => !report.errors.has(file) && file !== stoppedAt);
    }
    return { kind: "reported", diagnostics };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** The version of the tool, for a message: a JVM start, so only when there is one to give. */
export async function checkstyleVersion(wtPath: string): Promise<string | null> {
  const tool = await findCheckstyle(wtPath);
  if (!("executable" in tool)) return null;
  const scratch = await mkdtemp(path.join(tmpdir(), "loxel-checkstyle-"));
  try {
    const { env } = await toolEnv(tool, wtPath, scratch);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), VERSION_TIMEOUT_MS);
    const exit = await spawnCheckstyle(tool.executable, ["--version"], env, scratch, abort.signal);
    clearTimeout(timer);
    return /version:?\s*(\d[\w.-]*)/i.exec(exit.stdout)?.[1] ?? null;
  } catch (err) {
    log.debug("Asking Checkstyle for its version failed", { error: err });
    return null;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

interface PreparedRun {
  args: string[];
  env: Record<string, string>;
  tabWidth: number;
}

async function prepareRun(
  project: CheckstyleProject,
  tool: { path: string },
  wtPath: string,
  scratch: string,
): Promise<PreparedRun | { message: string }> {
  const { config } = project;
  if (config.kind === "not-found") {
    return { message: `its config ${config.location || "file"} isn't in the repository.` };
  }
  const properties = path.join(scratch, "checkstyle.properties");
  await Bun.write(
    properties,
    propertiesFileText({
      ...project.properties,
      "checkstyle.cache.file": path.join(scratch, "cache"),
    }),
  );
  const { env } = await toolEnv(tool, wtPath, scratch);
  const common = ["-f", "xml", "-p", properties];
  if (config.kind === "bundled") {
    return {
      args: [...common, "-c", `/${config.name}`],
      env,
      tabWidth: BUNDLED_TAB_WIDTH[config.name] ?? DEFAULT_TAB_WIDTH,
    };
  }
  const text = await readFile(config.path, "utf8").catch(() => null);
  if (text === null) return { message: `its config ${config.path} can't be read.` };
  if (ENTITY_CONFIG.test(text)) {
    return { message: "it builds property names from XML entities, which Loxel doesn't read." };
  }
  if (namesUnproxiedUrl(text, project.properties)) {
    return { message: "it names an FTP or mail URL, which Loxel doesn't fetch." };
  }
  const local = localConfig(text, [project.dir, project.rootDir, path.dirname(config.path)]);
  let configFile = config.path;
  if (local !== text) {
    configFile = path.join(scratch, "checkstyle.xml");
    await Bun.write(configFile, local);
  }
  return {
    args: [...common, "-c", configFile],
    env,
    tabWidth: configTabWidth(text, project.properties),
  };
}

/**
 * The environment for a run. Checkstyle's newest releases need a recent Java and every release runs
 * on one, while a project's own JDK may be old, so the newest JDK on the machine runs it. No host
 * name resolves and no URL scheme has a way out.
 */
async function toolEnv(
  tool: { path: string },
  wtPath: string,
  scratch: string,
): Promise<{ env: Record<string, string> }> {
  const root = path.resolve(wtPath);
  const runtimes = await listJavaRuntimes(root);
  const jdk = runtimes.find((runtime) => !isJdkInWorktree(runtime.path, root)) ?? null;
  const hosts = path.join(scratch, "hosts");
  await Bun.write(hosts, "127.0.0.1 localhost\n");
  return {
    env: {
      ...jdkToolEnv(tool.path, jdk),
      // A launcher reads empty as unset, and falls back to the Java it was installed for.
      ...(jdk ? {} : { JAVA_HOME: "" }),
      JAVA_TOOL_OPTIONS: [importJavaToolOptions(hosts), ...MORE_DEAD_ENDS, ...JVM_FLAGS].join(" "),
      JDK_JAVA_OPTIONS: "",
      _JAVA_OPTIONS: "",
    },
  };
}

interface ToolExit {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

/**
 * In a process group of its own, which a timeout or the session's end kills whole, and from the
 * run's scratch directory, so nothing in the repository is read through the working directory and
 * a crash report lands there too.
 */
async function spawnCheckstyle(
  executable: string,
  args: readonly string[],
  env: Record<string, string>,
  scratch: string,
  signal: AbortSignal,
): Promise<ToolExit> {
  if (signal.aborted) return { stdout: "", stderr: "", exitCode: null, timedOut: false };
  const proc = Bun.spawn([executable, ...args], {
    cwd: scratch,
    env: { ...buildSpawnEnv(), ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  const killGroup = (): void => killProcessGroup(proc.pid);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup();
  }, RUN_TIMEOUT_MS);
  signal.addEventListener("abort", killGroup, { once: true });
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode: proc.signalCode ? null : exitCode, timedOut };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", killGroup);
  }
}

// ---------------------------------------------------------------------------
// Preparing a config

/** A Checker's `cacheFile`, which would have it write there. */
const CACHE_FILE_PROPERTY =
  /<property\b(?:"[^"]*"|'[^']*'|[^>"'])*?\bname\s*=\s*["']cacheFile["'](?:"[^"]*"|'[^']*'|[^>"'])*?(?:\/>|>\s*<\/property\s*>)/g;
/** A way to spell a property's name so the text above doesn't show it. */
const ENTITY_CONFIG = /<!ENTITY|<property\b[^>]*\bname\s*=\s*["'][^"']*&/;
/** Properties naming a file to read, whose relative paths a run from elsewhere would miss. */
const FILE_PROPERTY =
  /(<property\b[^>]*?\bname\s*=\s*["'](?:file|headerFile)["'][^>]*?\bvalue\s*=\s*)(["'])([^"']*)\2/g;

/**
 * The config as a run should read it: `cacheFile` out, and a relative file it names, which the
 * project's build resolves against its directory, made absolute. `baseDirs` are where to look, in
 * order; a file in none of them stays as written, and Checkstyle reports it.
 */
export function localConfig(text: string, baseDirs: readonly string[]): string {
  return text
    .replace(CACHE_FILE_PROPERTY, "")
    .replace(FILE_PROPERTY, (whole, start: string, quote: string, value: string) => {
      if (!value || path.isAbsolute(value) || value.includes("${") || value.includes(":")) {
        return whole;
      }
      const found = baseDirs
        .map((dir) => path.join(dir, value))
        .find((file) => Bun.file(file).size);
      return found ? `${start}${quote}${xmlEscape(found)}${quote}` : whole;
    });
}

/**
 * Whether a property's value is a URL the JVM would reach without its proxy options: its FTP client
 * goes straight to a literal address. Only as a value's start or a list's entry, since patterns
 * such as `ignorePattern`'s often mention `ftp://`.
 */
export function namesUnproxiedUrl(text: string, properties: Record<string, string>): boolean {
  for (const [, double, single] of text.matchAll(
    /<property\b[^>]*?\bvalue\s*=\s*(?:"([^"]*)"|'([^']*)')/g,
  )) {
    const decoded = xmlDecode(double ?? single ?? "").replace(
      /\$\{([^}]+)\}/g,
      (whole, name: string) => properties[name] ?? whole,
    );
    if (/(?:^|[,\s])(?:jar:)?(?:ftp|mailto):/i.test(decoded)) return true;
  }
  return false;
}

function xmlEscape(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/** The width a config sets for tabs, which `column` counts in. */
export function configTabWidth(text: string, properties: Record<string, string>): number {
  const value = /<property\b[^>]*\bname\s*=\s*["']tabWidth["'][^>]*\bvalue\s*=\s*["']([^"']+)/.exec(
    text,
  )?.[1];
  if (!value) return DEFAULT_TAB_WIDTH;
  const expanded = value.replace(/^\$\{(.+)\}$/, (_, name: string) => properties[name] ?? "");
  const width = Number(expanded);
  return Number.isInteger(width) && width > 0 ? width : DEFAULT_TAB_WIDTH;
}

/** Text for `-p`: Latin-1 with escapes, as `java.util.Properties` loads it. */
export function propertiesFileText(properties: Record<string, string>): string {
  const escape = (text: string): string =>
    text.replace(/[\\:=#!\s]|[^\x20-\x7e]/g, (char) => {
      if (char === "\n") return "\\n";
      if (char === "\r") return "\\r";
      if (char === "\t") return "\\t";
      if (/[\\:=#! ]/.test(char)) return `\\${char}`;
      return `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
    });
  return Object.entries(properties)
    .map(([name, value]) => `${escape(name)}=${escape(value)}\n`)
    .join("");
}

// ---------------------------------------------------------------------------
// Reading a report

/** One `<error>`, as written: a line of 0 is about the file, and `column` is 1-based. */
export interface CheckstyleError {
  line: number;
  column: number | null;
  severity: keyof typeof SEVERITY;
  message: string;
  source: string;
}

/**
 * The `-f xml` report by file, each file it reached present even with no errors, or null when there
 * is none: nothing was checked. Checkstyle gives a file's path as given, or relative to a `basedir`
 * its config sets, so a name is matched to `files`.
 */
export function parseCheckstyleXml(
  stdout: string,
  files: readonly string[],
): { errors: Map<string, CheckstyleError[]> } | null {
  if (!stdout.includes("</checkstyle>")) return null;
  const errors = new Map<string, CheckstyleError[]>();
  let current: CheckstyleError[] | null = null;
  for (const [, tag, attributes] of stdout.matchAll(
    /<(file|error)\b((?:\s+[\w-]+="[^"]*")*)\s*\/?>/g,
  )) {
    const attrs = xmlAttributes(attributes ?? "");
    if (tag === "file") {
      const file = matchFile(attrs.get("name") ?? "", files);
      current = file ? [] : null;
      if (file && current) errors.set(file, current);
      continue;
    }
    const error = toError(attrs);
    if (current && error) current.push(error);
  }
  return { errors };
}

function matchFile(name: string, files: readonly string[]): string | undefined {
  const normalized = name.replaceAll("\\", "/");
  return (
    files.find((file) => file === name) ??
    files.find((file) => file.replaceAll("\\", "/").endsWith(`/${normalized}`))
  );
}

function toError(attrs: Map<string, string>): CheckstyleError | null {
  const severity = attrs.get("severity");
  const message = attrs.get("message");
  if (message === undefined || !isSeverity(severity)) return null;
  const column = attrs.get("column");
  return {
    line: Number(attrs.get("line") ?? 0) || 0,
    column: column === undefined ? null : Number(column) || null,
    severity,
    message,
    source: attrs.get("source") ?? "",
  };
}

function isSeverity(value: string | undefined): value is keyof typeof SEVERITY {
  return value === "error" || value === "warning" || value === "info";
}

function xmlAttributes(text: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const [, name, value] of text.matchAll(/([\w-]+)="([^"]*)"/g)) {
    if (name) attrs.set(name, xmlDecode(value ?? ""));
  }
  return attrs;
}

function xmlDecode(text: string): string {
  return text.replace(/&(#x?[\da-fA-F]+|apos|quot|lt|gt|amp);/g, (whole, entity: string) => {
    if (entity.startsWith("#")) {
      const code = entity[1] === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return Number.isNaN(code) ? whole : String.fromCodePoint(code);
    }
    return { apos: "'", quot: '"', lt: "<", gt: ">", amp: "&" }[entity] ?? whole;
  });
}

/** The file that stopped a run, from the exception Checkstyle ends with. */
export function stoppedAtFile(stderr: string, files: readonly string[]): string | null {
  const name = /Exception was thrown while processing (.+)$/m.exec(stderr)?.[1]?.trim();
  return name ? (matchFile(name, files) ?? null) : null;
}

/** What Checkstyle said, its deepest exception's message, without a JVM's stack trace or notices. */
export function failureMessage({
  stderr,
  stdout,
  exitCode,
}: Pick<ToolExit, "stderr" | "stdout" | "exitCode">): string {
  const lines = `${stderr}\n${stdout}`
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^at /.test(line) && !/^\.\.\. \d+ more$/.test(line))
    .filter((line) => !/^Picked up /.test(line) && !/^Checkstyle ends with /.test(line));
  const exceptions = lines.filter((line) => /^(Caused by: )?[\w.$]+(Exception|Error): /.test(line));
  const chosen = exceptions.at(-1) ?? lines.at(0);
  // Where a URL a config names went: the run's dead ends.
  if (chosen && /Connection refused|UnknownHost/.test(chosen)) {
    return "it names a URL, which Loxel doesn't fetch.";
  }
  if (!chosen) {
    return `it ended with ${exitCode === null ? "a signal" : `exit code ${exitCode}`} and no message.`;
  }
  // Without the advice it ends "Unable to instantiate" with, which reads as a problem to fix here.
  const message = chosen
    .replace(/^(Caused by: )?([\w.$]+(Exception|Error): )+/, "")
    .replace(/ Please recheck that .*$/, "");
  return message.length > MAX_FAILURE_LENGTH ? `${message.slice(0, MAX_FAILURE_LENGTH)}…` : message;
}

async function toDiagnostics(
  file: string,
  errors: readonly CheckstyleError[],
  tabWidth: number,
): Promise<CheckstyleDiagnostic[]> {
  if (errors.length === 0) return [];
  const text = await readFile(file, "utf8").catch(() => "");
  const lines = text.split(/\r?\n/);
  return errors.map((error) => toDiagnostic(error, lines, tabWidth));
}

/** A diagnostic for `error`. No format gives an end column, so the range is the word there. */
export function toDiagnostic(
  error: CheckstyleError,
  lines: readonly string[],
  tabWidth: number,
): CheckstyleDiagnostic {
  const line = Math.max(0, Math.min(error.line - 1, Math.max(0, lines.length - 1)));
  const text = lines[line] ?? "";
  const { start, end } = columnRange(text, error.column, tabWidth);
  return {
    range: { start: { line, character: start }, end: { line, character: end } },
    severity: SEVERITY[error.severity],
    source: "checkstyle",
    message: error.message,
    ...checkInfo(error.source),
  };
}

function columnRange(
  text: string,
  column: number | null,
  tabWidth: number,
): { start: number; end: number } {
  if (column === null) {
    // About the line as a whole, such as its length.
    const indent = /^\s*/.exec(text)?.[0].length ?? 0;
    return { start: indent, end: Math.max(indent, text.trimEnd().length) };
  }
  const start = characterAt(text, column, tabWidth);
  if (start >= text.length) return { start: Math.max(0, text.length - 1), end: text.length };
  const word = /^[\p{L}\p{N}_$]+/u.exec(text.slice(start))?.[0].length;
  return { start, end: start + (word ?? 1) };
}

/** The character of a 1-based `column`, which counts a tab up to the next multiple of its width. */
function characterAt(text: string, column: number, tabWidth: number): number {
  let width = 0;
  let index = 0;
  while (index < text.length && width + 1 < column) {
    const point = text.codePointAt(index) ?? 0;
    width = point === 9 ? (Math.floor(width / tabWidth) + 1) * tabWidth : width + 1;
    index += point > 0xffff ? 2 : 1;
  }
  return index;
}

/** A check's short name, and its page. Checks named by a config's `id` or of another's have none. */
function checkInfo(source: string): Pick<CheckstyleDiagnostic, "code" | "codeDescription"> {
  if (!source) return {};
  const name = (source.split(".").at(-1) ?? source).replace(/Check$/, "");
  if (!source.startsWith(CHECKS_PACKAGE)) return { code: name };
  const group = source.slice(CHECKS_PACKAGE.length).split(".").slice(0, -1).join("/");
  const page = DOCS_MISC_GROUPS.has(group) ? "misc" : group;
  return {
    code: name,
    codeDescription: { href: `${CHECK_DOCS}/${page}/${name.toLowerCase()}.html#${name}` },
  };
}
