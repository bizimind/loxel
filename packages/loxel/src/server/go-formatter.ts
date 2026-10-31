import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { isDirectory } from "@/fs-utils";
import { isRecord } from "@/lib/is-record";

import { getGoEnv, goSpawnEnv } from "./go-env";
import { dirsUpToRoot, type FileFormatter, type LanguageFormatter } from "./language-formatter";
import { logger } from "./logger";
import { isInside } from "./shipped-by-repo";
import { parseToml, recordAt } from "./toml-file";

const log = logger.child("format");

const GOFMT: FileFormatter = { command: "gofmt", args: "" };

const GOLANGCI_LINT = "golangci-lint";

/** golangci-lint's config names, in the order it prefers them within a directory. */
const GOLANGCI_CONFIG_FILES = [
  ".golangci.json",
  ".golangci.toml",
  ".golangci.yaml",
  ".golangci.yml",
];

/** Often deliberately unformatted, or not the project's own code. */
const SKIPPED_DIRS: ReadonlySet<string> = new Set(["vendor", "testdata"]);

const GOROOT_LOOKUP_TIMEOUT_MS = 2_000;

/**
 * Go's regular expressions run in linear time and JavaScript's backtrack, on the server's thread,
 * so patterns are only run within this estimate of the steps they can take (see {@link matchCost}).
 */
const MAX_MATCH_COST = 10_000_000;

/** Go syntax that compiles in JavaScript with another meaning, or is not Go's at all. */
const UNTRANSLATABLE_REGEX = /\[:\^?[a-z]+:\]|\[\^?\]|\\[pPQC1-9]|\\x\{|\(\?<?[=!]/;

/** Exported for tests, which need a lookup that a loaded machine cannot time out. */
export function goFormatterWith(gorootLookupTimeoutMs: number): LanguageFormatter {
  return {
    extensions: ["go"],
    detect: detectGoFormatter,
    spawnOptions: async (command, dir, wtRoot) => {
      // gofumpt and goimports read go.mod from the cwd only.
      const cwd = existingDir(dir, wtRoot);
      const env = goSpawnEnv(wtRoot, null);
      const onPath = (tool: string) => Bun.which(tool, { PATH: env.PATH });
      const goroot =
        onPath(command) && onPath("go")
          ? undefined
          : await gorootWithin(wtRoot, gorootLookupTimeoutMs);
      return { cwd, env, binDirs: goroot ? [join(goroot, "bin")] : [] };
    },
  };
}

export const goFormatter = goFormatterWith(GOROOT_LOOKUP_TIMEOUT_MS);

/**
 * Pick the Go formatter for a file in `startDir`, walking up to `wtRoot`. The nearest `.golangci.*`
 * decides alone, as golangci-lint never merges configs: with `version: "2"` and enabled formatters
 * it selects `golangci-lint fmt`, when that is installed. Anything else gets gofmt inside a module
 * or workspace, and no formatter outside one.
 *
 * Not cached: a save costs a few `statSync` calls per directory level plus parsing one config,
 * negligible next to spawning the formatter.
 */
function detectGoFormatter(
  startDir: string,
  wtRoot: string,
  fileName?: string,
): FileFormatter | null {
  const root = resolve(wtRoot);
  const dir = resolve(root, startDir);
  const segments = relative(root, dir).split(sep);
  if (segments.some((segment) => SKIPPED_DIRS.has(segment))) return null;

  const dirs = dirsUpToRoot(dir, root);
  const configPath = dirs.map(configIn).find(Boolean);
  const config = configPath ? readConfig(configPath) : undefined;
  if (configPath && config && enablesFormatters(config)) {
    if (fileName && isExcluded(config, configPath, join(dir, fileName), dirs, root)) return null;
    const configArg = configArgFrom(existingDir(dir, root), configPath);
    if (configArg && Bun.which(GOLANGCI_LINT, { PATH: goSpawnEnv(root, null).PATH })) {
      // Explicit, since its own search can leave the worktree.
      return { command: GOLANGCI_LINT, args: `fmt --stdin --config ${configArg}` };
    }
  }
  const inModule = dirs.some((d) => isFile(join(d, "go.mod")) || isFile(join(d, "go.work")));
  return inModule ? GOFMT : null;
}

/** The config golangci-lint would take from `dir`. */
function configIn(dir: string): string | undefined {
  return GOLANGCI_CONFIG_FILES.map((name) => join(dir, name)).find(isFile);
}

function isFile(path: string): boolean {
  try {
    return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
  } catch {
    return false;
  }
}

/**
 * `configPath` for a tool running in `cwd`. Relative, as args are split on whitespace, and between
 * physical paths, since `..` leaves the real directory when `cwd` is reached through a symlink.
 * Undefined when that still has whitespace, or the paths cannot be resolved.
 */
function configArgFrom(cwd: string, configPath: string): string | undefined {
  try {
    const configDir = realpathSync(dirname(configPath));
    const arg = relative(realpathSync(cwd), join(configDir, basename(configPath)));
    return /\s/.test(arg) ? undefined : arg;
  } catch {
    return undefined;
  }
}

/** The config's top-level table, or undefined when it is unreadable. */
function readConfig(path: string): Record<string, unknown> | undefined {
  try {
    const text = readFileSync(path, "utf-8");
    if (path.endsWith(".toml")) return parseToml(text);
    const parsed: unknown = path.endsWith(".json") ? JSON.parse(text) : Bun.YAML.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch (err) {
    log.debug("Could not read golangci-lint config", { path, error: err });
    return undefined;
  }
}

function enablesFormatters(config: Record<string, unknown>): boolean {
  const enable = recordAt(config, "formatters")?.enable;
  return String(config.version) === "2" && Array.isArray(enable) && enable.length > 0;
}

/**
 * Whether the config's `formatters.exclusions.paths` covers `filePath`. golangci-lint cannot tell:
 * it sees stdin as `<standard input>`. Patterns match the path relative to its
 * `run.relative-path-mode` base, by default the config's directory. A pattern that cannot run here
 * counts as covering the file: leaving a file alone is easier to notice and undo than rewriting one
 * the project excludes.
 */
function isExcluded(
  config: Record<string, unknown>,
  configPath: string,
  filePath: string,
  dirs: readonly string[],
  root: string,
): boolean {
  const paths = recordAt(recordAt(config, "formatters"), "exclusions")?.paths;
  if (!Array.isArray(paths)) return false;
  const path = relative(exclusionBase(config, configPath, dirs, root), filePath);
  const regexes: RegExp[] = [];
  let cost = 0;
  for (const pattern of paths) {
    const regex = typeof pattern === "string" ? compileGoRegex(pattern) : null;
    if (regex) cost += matchCost(regex.source, path.length);
    if (!regex || cost > MAX_MATCH_COST) {
      log.warn("Formatter exclusion pattern cannot run; not formatting", { configPath, pattern });
      return true;
    }
    regexes.push(regex);
  }
  return regexes.some((regex) => regex.test(path));
}

function exclusionBase(
  config: Record<string, unknown>,
  configPath: string,
  dirs: readonly string[],
  root: string,
): string {
  switch (recordAt(config, "run")?.["relative-path-mode"]) {
    case "gomod":
      return dirs.find((dir) => isFile(join(dir, "go.mod"))) ?? root;
    case "gitroot":
    case "wd":
      // A project's commands run from its top level.
      return root;
    default:
      return dirname(configPath);
  }
}

/** A Go regular expression as a JavaScript one, or null when it has no equivalent. */
function compileGoRegex(pattern: string): RegExp | null {
  if (UNTRANSLATABLE_REGEX.test(pattern)) return null;
  const flags = /^\(\?([ims]+)\)/.exec(pattern);
  const source = (flags ? pattern.slice(flags[0].length) : pattern)
    .replaceAll("(?P<", "(?<")
    .replaceAll("\\A", "^")
    .replaceAll("\\z", "$");
  try {
    return new RegExp(source, flags?.[1]);
  } catch {
    return null;
  }
}

/**
 * Roughly the most steps backtracking can take on a path of `length` characters: every start
 * position, times every split of it among quantifiers, times both ways through each choice. A
 * repeated group can take exponentially many, whatever the path.
 */
function matchCost(source: string, length: number): number {
  const syntax = source
    .replace(/\\./g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replaceAll("(?", "(");
  if (/\)[*+{]/.test(syntax)) return Number.POSITIVE_INFINITY;
  const quantifiers = syntax.match(/[*+]|\{\d*,?\d*\}/g)?.length ?? 0;
  const choices = syntax.match(/[?|]/g)?.length ?? 0;
  return Math.max(length, 2) ** (quantifiers + 1) * 2 ** choices;
}

/** The nearest directory that exists, since `dir` may be gone when saving a file in it. */
function existingDir(dir: string, wtRoot: string): string {
  return dirsUpToRoot(dir, wtRoot).find(isDirectory) ?? wtRoot;
}

/**
 * The worktree's GOROOT from the shared Go resolution, within `timeoutMs` so it cannot hold up a
 * save, unless it is in the worktree.
 */
async function gorootWithin(wtRoot: string, timeoutMs: number): Promise<string | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const env = await Promise.race([
    getGoEnv(wtRoot),
    new Promise<null>((done) => {
      timer = setTimeout(() => done(null), timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  const goroot = env?.goroot;
  return goroot && isAbsolute(goroot) && !isInside(goroot, resolve(wtRoot)) ? goroot : undefined;
}
