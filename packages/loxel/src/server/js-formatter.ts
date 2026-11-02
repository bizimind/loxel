import { realpathSync } from "node:fs";
import { basename, delimiter, dirname, extname, isAbsolute, join, resolve } from "node:path";

import { isDirectory } from "@/fs-utils";
import { isRecord } from "@/lib/is-record";

import { readConfigFile } from "./config-file-read";
import type { BackendMode } from "./formatter-backends";
import {
  dirsUpToRoot,
  type FileFormatter,
  type FormatterDecline,
  type FormatterFailure,
  type FormatterSpawnOptions,
  type LanguageFormatter,
  nodeModulesBin,
} from "./language-formatter";
import { logger } from "./logger";
import { getNodeEnv } from "./node-env";
import { pathOutsideWorktree } from "./python-env";
import { isRepoTrusted, reportRepoRestriction } from "./repo-trust";
import { isVersionManagerShim } from "./rust-tool-shim";
import { buildSpawnEnv } from "./shell-env";
import { isInside } from "./shipped-by-repo";
import { recordAt } from "./toml-file";

const log = logger.child("format");

/**
 * Extensions both prettier and oxfmt format out of the box (verified against prettier 3.9
 * `--support-info` and oxfmt 0.68.0 via `--stdin-filepath` and `--lsp`). Alias spellings
 * (yml, mjs, scss, mdx, ...) are listed explicitly so that a project with both formatters
 * routes the whole language to the same formatter, not just the canonical extension.
 */
const SHARED_FORMAT_EXTENSIONS = [
  "ts",
  "tsx",
  "mts",
  "cts",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "css",
  "scss",
  "less",
  "json",
  "jsonc",
  "json5",
  "md",
  "mdx",
  "markdown",
  "yaml",
  "yml",
  "html",
  "vue",
  "graphql",
  "gql",
];

type PackageJson = Record<string, unknown> | undefined;

interface JsTool {
  label: string;
  command: string;
  args: string;
  backendMode: BackendMode;
  extensions: readonly string[];
  /** The npm package that installs it; depending on it is the weaker opt-in signal. */
  dependency: string;
  hasConfig(dir: string, packageJson: PackageJson): boolean;
  /** A config in `dir` turns the tool off, so depending on it says nothing about formatting. */
  isTurnedOff?(dir: string): boolean;
}

const hasAnyFile = (dir: string, names: readonly string[]) =>
  names.some((name) => readConfigFile(join(dir, name)) !== undefined);

/**
 * Whether a Biome config in `dir` has the formatter on, undefined with no config. One that turns it
 * off is there for the linter alone. One that cannot be parsed still counts: Biome reports that
 * better than a silent other formatter. In the order Biome prefers them, checked against 2.5.11.
 */
function biomeFormatterOn(dir: string): boolean | undefined {
  for (const name of ["biome.json", "biome.jsonc", ".biome.json", ".biome.jsonc"]) {
    const text = readConfigFile(join(dir, name));
    if (text === undefined) continue;
    try {
      return recordAt(Bun.JSONC.parse(text), "formatter")?.enabled !== false;
    } catch {
      return true;
    }
  }
  return undefined;
}

/**
 * Checked against 2.5.11. Left out: `vue`, `svelte` and `astro`, where Biome formats only the
 * script, and `html`, which is off unless the project enables it, as stdin then exits 1.
 */
const BIOME: JsTool = {
  label: "Biome",
  command: "biome",
  args: "format --stdin-file-path={file}",
  backendMode: "command",
  extensions: [
    "ts",
    "tsx",
    "mts",
    "cts",
    "js",
    "jsx",
    "mjs",
    "cjs",
    "json",
    "jsonc",
    "css",
    "graphql",
    "gql",
  ],
  dependency: "@biomejs/biome",
  hasConfig: (dir) => biomeFormatterOn(dir) === true,
  isTurnedOff: (dir) => biomeFormatterOn(dir) === false,
};

/** Config files prettier discovers on its own (its config searcher in 3.9), but `package.yaml`. */
const PRETTIER_CONFIG_FILES = [
  ".prettierrc",
  ".prettierrc.json",
  ".prettierrc.yml",
  ".prettierrc.yaml",
  ".prettierrc.json5",
  ".prettierrc.toml",
  ".prettierrc.js",
  ".prettierrc.cjs",
  ".prettierrc.mjs",
  ".prettierrc.ts",
  ".prettierrc.cts",
  ".prettierrc.mts",
  "prettier.config.js",
  "prettier.config.cjs",
  "prettier.config.mjs",
  "prettier.config.ts",
  "prettier.config.cts",
  "prettier.config.mts",
];

const PRETTIER: JsTool = {
  label: "Prettier",
  command: "prettier",
  args: "--stdin-filepath {file}",
  backendMode: "library",
  // `toml` is intentionally absent: prettier has no TOML support.
  extensions: [...SHARED_FORMAT_EXTENSIONS, "svelte", "astro"],
  dependency: "prettier",
  hasConfig: (dir, packageJson) =>
    hasAnyFile(dir, PRETTIER_CONFIG_FILES) ||
    (packageJson !== undefined && "prettier" in packageJson),
};

/** Config files oxfmt discovers on its own (see `oxfmt --help`, "Config Options"). */
const OXFMT_CONFIG_FILES = [
  ".oxfmtrc.json",
  ".oxfmtrc.jsonc",
  ".oxfmtrc.ts",
  ".oxfmtrc.mts",
  ".oxfmtrc.cts",
  ".oxfmtrc.js",
  ".oxfmtrc.mjs",
  ".oxfmtrc.cjs",
];

const OXFMT: JsTool = {
  label: "oxfmt",
  command: "oxfmt",
  args: "--stdin-filepath={file}",
  backendMode: "lsp",
  // Deliberately excluded (oxfmt 0.68.0): `svelte` (disabled unless the project enables the
  // `svelte` config option and installs `svelte`) and `astro` (unsupported).
  extensions: [...SHARED_FORMAT_EXTENSIONS, "toml"],
  dependency: "oxfmt",
  hasConfig: (dir) => hasAnyFile(dir, OXFMT_CONFIG_FILES),
};

/**
 * The order within one directory. Biome first: it only counts when its formatter is on, and it
 * leaves the languages it lacks (markdown, YAML) to a prettier beside it, the usual way to run both.
 */
const JS_TOOLS: readonly JsTool[] = [BIOME, PRETTIER, OXFMT];

/** These find their config from the working directory only, so they cannot run from elsewhere. */
const NEEDS_PROJECT_CWD: ReadonlySet<string> = new Set(["biome", "deno"]);

function readPackageJson(dir: string): PackageJson {
  const text = readConfigFile(join(dir, "package.json"));
  if (text === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Regular and dev dependencies. A peer dependency says the consumer brings the package, which is
 * how a prettier plugin declares it, not that this project formats with it.
 */
function dependsOn(packageJson: PackageJson, name: string): boolean {
  return [packageJson?.dependencies, packageJson?.devDependencies].some(
    (deps) => isRecord(deps) && name in deps,
  );
}

function hasDependencySignal(tool: JsTool, dir: string, packageJson: PackageJson): boolean {
  return dependsOn(packageJson, tool.dependency) && !tool.isTurnedOff?.(dir);
}

function toolSignal(tool: JsTool, dir: string, packageJson: PackageJson): boolean {
  return tool.hasConfig(dir, packageJson) || hasDependencySignal(tool, dir, packageJson);
}

/**
 * The tool for a file with extension `ext`, walking from its directory up to `wtRoot`: the nearest
 * directory with a signal decides, and in a directory a config beats a dependency, each in
 * {@link JS_TOOLS} order. A tool that cannot format the extension does not count, so a markdown
 * file under a Biome-only subproject goes on to the prettier at the root.
 *
 * Not cached: a save costs a few file reads per directory level, negligible next to formatting.
 */
function resolveTool(
  startDir: string,
  wtRoot: string,
  ext: string,
): { tool: JsTool; dir: string } | null {
  const claiming = JS_TOOLS.filter((tool) => tool.extensions.includes(ext));
  for (const dir of dirsUpToRoot(startDir, wtRoot)) {
    const packageJson = readPackageJson(dir);
    const tool =
      claiming.find((candidate) => candidate.hasConfig(dir, packageJson)) ??
      claiming.find((candidate) => hasDependencySignal(candidate, dir, packageJson));
    if (tool) return { tool, dir };
  }
  return null;
}

function heldBackNotice(label: string): string {
  return `Format on save skipped: ${label} would run code from this repository, which you haven't trusted. Use Restricted in the status bar to choose.`;
}

function reportHeldBack(label: string, wtRoot: string): void {
  reportRepoRestriction(wtRoot, `${label} doesn't format on save.`);
}

function notInstalledNotice(label: string): string {
  return `Format on save skipped: this project uses ${label}, which is not installed. Install the project's dependencies in a terminal.`;
}

function detectFor(
  tool: JsTool,
  startDir: string,
  wtRoot: string,
  fileName: string | undefined,
): FileFormatter | FormatterDecline | null {
  // Settings lists every tool the root signals, each with its own extensions.
  const matchedDir = fileName
    ? resolveTool(startDir, wtRoot, extname(fileName).slice(1).toLowerCase())
    : toolSignal(tool, wtRoot, readPackageJson(wtRoot))
      ? { tool, dir: wtRoot }
      : null;
  if (matchedDir?.tool !== tool) return null;
  const { dir } = matchedDir;

  if (isRepoTrusted(wtRoot)) {
    return {
      command: tool.command,
      args: tool.args,
      backendMode: tool.backendMode,
      backendDir: dir,
      // A subproject can install the tool under a config further up.
      backendToolDir: nearestInstallDir(tool, startDir, wtRoot) ?? dir,
    };
  }
  const usersOwn = Bun.which(tool.command, { PATH: machinePath(tool.command, wtRoot) }) !== null;
  if (!usersOwn && !nearestInstallDir(tool, startDir, wtRoot)) {
    return { notice: notInstalledNotice(tool.label) };
  }
  // A listing in Settings holds back nothing, so it must not make the UI ask.
  if (fileName) reportHeldBack(tool.label, wtRoot);
  return { notice: heldBackNotice(tool.label) };
}

/** The nearest directory from `dir` up to the worktree root that installs `tool`. */
function nearestInstallDir(tool: JsTool, dir: string, wtRoot: string): string | undefined {
  return dirsUpToRoot(dir, wtRoot).find(
    (candidate) =>
      Bun.which(tool.command, { PATH: nodeModulesBin(candidate) }) !== null ||
      readConfigFile(join(candidate, "node_modules", tool.dependency, "package.json")) !==
        undefined,
  );
}

/**
 * The login-shell `PATH` without what a repository controls: relative entries, the worktree's own
 * directories, and an entry whose `command` is a link leading back in. What an untrusted repository
 * runs by name comes from this.
 */
function machinePath(command: string, wtRoot: string): string {
  const root = resolve(wtRoot);
  const entries = pathOutsideWorktree(buildSpawnEnv().PATH ?? "", root)
    .split(delimiter)
    .filter(isAbsolute);
  if (command.includes("/")) return entries.join(delimiter);
  const realRoot = realpathOr(root);
  return entries
    .filter((dir) => {
      const tool = Bun.which(command, { PATH: dir });
      return !tool || !isInside(realpathOr(tool), realRoot);
    })
    .join(delimiter);
}

function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Biome's `.bin` entry is a Node script that only finds and starts this binary. Running the binary
 * directly leaves out Node, which from inside the project could be a version manager's shim.
 * `node_modules/@biomejs/biome` is a link under pnpm, with the binary's package beside the target.
 */
export function biomeNativeDir(dir: string): string | null {
  const packageDir = join(dir, "node_modules", "@biomejs", "biome");
  if (!isDirectory(packageDir)) return null;
  const native = join(realpathOr(packageDir), "..", `cli-${process.platform}-${process.arch}`);
  return Bun.which("biome", { PATH: native }) ? native : null;
}

/**
 * `PATH` for a project's own JavaScript tools in a trusted repository: a subproject's
 * `node_modules/.bin` before its parents', then the worktree's Node, so a script's `env node` finds
 * that one and not whatever a shell would, then the login shell's absolute entries.
 */
export async function projectToolPath(dir: string, wtRoot: string): Promise<string> {
  const projectDirs = dirsUpToRoot(dir, wtRoot).flatMap((candidate) => [
    biomeNativeDir(candidate),
    nodeModulesBin(candidate),
  ]);
  const { env } = await getNodeEnv(wtRoot);
  const loginPath = (buildSpawnEnv().PATH ?? "").split(delimiter).filter(isAbsolute);
  return [...projectDirs, env ? dirname(env.nodePath) : null, ...loginPath]
    .filter((entry): entry is string => entry !== null)
    .join(delimiter);
}

/** The directory package `name` is installed in for `dir`, nearest first, within the worktree. */
export function findProjectPackage(name: string, dir: string, wtRoot: string): string | undefined {
  return dirsUpToRoot(dir, wtRoot)
    .map((candidate) => join(candidate, "node_modules", name))
    .find((packageDir) => readConfigFile(join(packageDir, "package.json")) !== undefined);
}

/** What a script's first line runs: the file, or the program a `/usr/bin/env` line names. */
function shebangInterpreter(firstLine: string): string | undefined {
  const [program, ...args] = firstLine.slice(2).trim().split(/\s+/);
  if (basename(program ?? "") !== "env") return program;
  return args.find((arg) => !arg.startsWith("-"));
}

/**
 * Whether starting `tool` from a directory could make a version manager act on that directory's
 * pin files: it is a shim, or a script whose interpreter or `node` is one (pnpm's `.bin` entries
 * are `sh` scripts that run `node`). A real binary reads no pins.
 */
async function startsVersionManager(tool: string, PATH: string): Promise<boolean> {
  if (!(await isVersionManagerShim(tool))) return false;
  if (basename(dirname(realpathOr(tool))) === "shims" || basename(dirname(tool)) === "shims") {
    return true;
  }
  const head = await Bun.file(tool)
    .slice(0, 256)
    .text()
    .catch(() => "");
  if (!head.startsWith("#!")) return true;
  const interpreter = shebangInterpreter(head.split("\n", 1)[0] ?? "");
  const programs = [interpreter && Bun.which(interpreter, { PATH }), Bun.which("node", { PATH })];
  for (const program of programs) {
    if (program && (await isVersionManagerShim(program))) return true;
  }
  return false;
}

/**
 * How to run any command formatting these extensions, manual overrides and the worktree-root deno
 * rule included. `PATH` is complete here, with `binDirs` empty, so an untrusted repository's
 * commands by name never get the worktree's `node_modules/.bin`. A tool Loxel knows runs from the
 * file's directory, and any other command from the worktree, as in other languages.
 */
async function jsSpawnOptions(
  command: string,
  dir: string,
  wtRoot: string,
): Promise<FormatterSpawnOptions> {
  const root = resolve(wtRoot);
  const name = basename(command);
  const trusted = isRepoTrusted(root);
  const PATH = trusted ? await projectToolPath(dir, root) : machinePath(command, root);
  // Shims honor this where the manager offers it; running outside the project covers the others.
  const env = { PATH, MISE_NOT_FOUND_AUTO_INSTALL: "0" };
  const isKnownTool = NEEDS_PROJECT_CWD.has(name) || JS_TOOLS.some((t) => t.command === name);
  const cwd = isKnownTool ? (dirsUpToRoot(dir, root).find(isDirectory) ?? root) : root;
  const tool = Bun.which(command.includes("/") ? resolve(root, command) : command, { PATH });
  const throughShim = tool !== null && (await startsVersionManager(tool, PATH));
  // This `PATH` has the project's tools; nothing async separates this answer from the spawn.
  if (trusted && !isRepoTrusted(root)) return { skip: {} };
  if (!throughShim) return { cwd, env, binDirs: [] };
  if (NEEDS_PROJECT_CWD.has(name)) {
    return {
      skip: {
        notice: `Format on save skipped: "${command}" would start through a version manager's shim, which Loxel doesn't run inside a project. Add the tool's own directory to your PATH.`,
      },
    };
  }
  return { cwd: "/", env, binDirs: [] };
}

/** Skipping keeps a failure here from falling back to the defaults, which are not for these tools. */
async function safeSpawnOptions(
  command: string,
  dir: string,
  wtRoot: string,
): Promise<FormatterSpawnOptions> {
  try {
    return await jsSpawnOptions(command, dir, wtRoot);
  } catch (err) {
    log.warn("Could not prepare a JavaScript formatter; not formatting", { wtRoot, error: err });
    return { skip: {} };
  }
}

function jsFailureNotice(failure: FormatterFailure): string | undefined {
  if (failure.kind !== "not-installed") return undefined;
  const tool = JS_TOOLS.find((candidate) => candidate.command === failure.command);
  return tool && notInstalledNotice(tool.label);
}

/**
 * One module per tool, so Settings lists each with its own extensions. They agree on the file's
 * tool through {@link resolveTool}, so their order does not matter.
 */
export const jsFormatters: readonly LanguageFormatter[] = JS_TOOLS.map((tool) => ({
  extensions: tool.extensions,
  detect: (dir, wtRoot, fileName) => detectFor(tool, dir, wtRoot, fileName),
  spawnOptions: safeSpawnOptions,
  failureNotice: jsFailureNotice,
}));
