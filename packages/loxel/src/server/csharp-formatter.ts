import { statSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";

import { isDirectory } from "@/fs-utils";
import { isRecord } from "@/lib/is-record";

import {
  isVersionManagerShim,
  prepareDotnet,
  readDotnetToolManifests,
  resolveDotnet,
  toolClaimsCommand,
} from "./csharp-env";
import {
  dirsUpToRoot,
  type FileFormatter,
  type FormatterDecline,
  type FormatterFailure,
  type FormatterSpawnOptions,
  type LanguageFormatter,
} from "./language-formatter";
import { logger } from "./logger";
import { pathOutsideWorktree } from "./python-env";
import { buildSpawnEnv } from "./shell-env";
import { isInside, isShippedByRepo } from "./shipped-by-repo";

const log = logger.child("format");

const CSHARPIER = "csharpier";
const DOTNET = "dotnet";

/** XML is left out: CSharpier can format it, but whitespace in project files can be significant. */
export const csharpFormatter: LanguageFormatter = {
  extensions: ["cs", "csx"],
  detect: detectCSharpFormatter,
  spawnOptions: csharpSpawnOptions,
  failureNotice: csharpFailureNotice,
};

/**
 * An ignored file exits 0 with nothing on stdout, which format-service takes as no result, so the
 * file is written as it is. A syntax error exits 1.
 */
const STDIN_ARGS = `format --stdin-path {file}`;
const PATH_TOOL: FileFormatter = { command: CSHARPIER, args: STDIN_ARGS };

/** CSharpier's own config names, checked against 1.3.0, which also reads `.yml`. */
const CONFIG_FILES = [".csharpierrc", ".csharpierrc.json", ".csharpierrc.yaml", ".csharpierrc.yml"];
/** Far above any real manifest or config; a larger file does not count. */
const MAX_PROJECT_FILE_BYTES = 1_024 * 1_024;
/** In what `dotnet tool run` prints for a manifest's tool that is not in the local tool cache. */
const NOT_RESTORED_HINT = "dotnet tool restore";
const LOCAL_TOOL_DECLINE: FormatterDecline = {
  notice:
    "Format on save skipped: Loxel doesn't run a project's local CSharpier yet. It uses a `csharpier` on your PATH instead, which you can install with `dotnet tool install -g csharpier`.",
};

/**
 * Pick how to run CSharpier for a file in `startDir`, walking up to `wtRoot`. A project opts in
 * with a tool manifest listing it or with a CSharpier config. Both run a `csharpier` from `PATH`:
 * the manifest's own version does not run until the repository trust gate restores
 * `dotnet tool run` for it. A bare project or `.editorconfig` formats nothing, like the other
 * formatters' opt-in signals. CSharpier resolves its own nested options from `--stdin-path`.
 *
 * Not cached: a save costs a few `statSync` calls per directory level plus parsing the manifests
 * on the way, negligible next to spawning the formatter. So does the SDK check, which reads one
 * `global.json` and asks git only about its `sdk.paths` entries.
 */
function detectCSharpFormatter(
  startDir: string,
  wtRoot: string,
): FileFormatter | FormatterDecline | null {
  const dirs = dirsUpToRoot(startDir, wtRoot);
  if (findLocalToolDir(dirs)) return isOnPath(wtRoot) ? PATH_TOOL : LOCAL_TOOL_DECLINE;
  const hasConfig = dirs.some((dir) => CONFIG_FILES.some((name) => isSmallFile(join(dir, name))));
  return hasConfig ? PATH_TOOL : null;
}

function isOnPath(wtRoot: string): boolean {
  const PATH = pathOutsideWorktree(buildSpawnEnv().PATH ?? "", resolve(wtRoot))
    .split(delimiter)
    .filter(isAbsolute)
    .join(delimiter);
  return Bun.which(CSHARPIER, { PATH }) !== null;
}

/**
 * The nearest directory whose manifest gives `dotnet tool run csharpier` this tool, as dotnet walks
 * them: a manifest without it passes the search upward, unless it has `isRoot: true`.
 */
function findLocalToolDir(dirs: readonly string[]): string | undefined {
  for (const dir of dirs) {
    const manifests = readDotnetToolManifests(dir);
    if (listsCSharpier(manifests)) return dir;
    if (manifests.some((manifest) => manifest.isRoot === true)) return undefined;
  }
  return undefined;
}

/**
 * Whether `csharpier` runs the package of that name: the only tool claiming the command. Before
 * 1.0 the command was `dotnet-csharpier`, which has no `format` subcommand, so that does not count.
 */
function listsCSharpier(manifests: readonly Record<string, unknown>[]): boolean {
  const claiming = manifests.flatMap(({ tools }) =>
    isRecord(tools)
      ? Object.entries(tools)
          .filter(([, tool]) => toolClaimsCommand(tool, CSHARPIER))
          .map(([id]) => id)
      : [],
  );
  return claiming.length > 0 && claiming.every((id) => id.toLowerCase() === CSHARPIER);
}

function isSmallFile(path: string): boolean {
  try {
    const info = statSync(path, { throwIfNoEntry: false });
    return info !== undefined && info.isFile() && info.size <= MAX_PROJECT_FILE_BYTES;
  } catch {
    return false;
  }
}

async function csharpSpawnOptions(
  command: string,
  dir: string,
  wtRoot: string,
): Promise<FormatterSpawnOptions> {
  try {
    if (isDotnet(command)) return await dotnetSpawnOptions(dir, wtRoot);
    if (command !== CSHARPIER) return {};
    // From outside the repository, with `{file}` absolute: CSharpier finds its config and ignore file
    // from that path, and a version manager's shim picks no version from a file the repository has.
    return { cwd: homedir(), env: { PATH: await machinePath(command, wtRoot) }, binDirs: [] };
  } catch (err) {
    // format-service's defaults, which a failure here would fall back to, are not for these tools.
    log.warn("Could not prepare CSharpier; not formatting", { wtRoot, error: err });
    return { skip: {} };
  }
}

/** Lower-cased: a case-insensitive disk runs `Dotnet` too. */
function isDotnet(command: string): boolean {
  return basename(command).toLowerCase() === DOTNET;
}

async function dotnetSpawnOptions(dir: string, wtRoot: string): Promise<FormatterSpawnOptions> {
  const dirs = dirsUpToRoot(dir, wtRoot);
  // dotnet finds the manifest from its working directory.
  const cwd = findLocalToolDir(dirs) ?? dirs.find(isDirectory) ?? resolve(wtRoot);
  // On every save, and the run stays in `cwd`: other projects' global.json files do not apply.
  const prepared = await prepareDotnet(wtRoot, { cwd, applyingOnly: true });
  if (!prepared) {
    const dotnet = await resolveDotnet(wtRoot);
    if (!dotnet) {
      return {
        skip: {
          notice:
            "Format on save skipped: this project uses CSharpier through dotnet, which is not on your PATH. Install the .NET SDK.",
        },
      };
    }
    if (await isVersionManagerShim(dotnet)) {
      return {
        skip: {
          notice:
            "Format on save skipped: \"dotnet\" on your PATH is a version manager's shim, which Loxel runs in a project only once you trust its repository. Trust it, or add the SDK's own directory to your PATH.",
        },
      };
    }
    log.info("dotnet may not run in this worktree; not formatting", { wtRoot });
    return { skip: {} };
  }
  const { dotnetPath, env } = prepared;
  return {
    cwd: prepared.cwd,
    env: withAbsolutePath(env),
    // First, so `dotnet` by name is the one that the check above covered.
    binDirs: [dirname(dotnetPath)],
  };
}

/** A relative entry would depend on the formatter's directory, here inside the project. */
function withAbsolutePath(env: Record<string, string | undefined>): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined) kept[name] = value;
  }
  kept.PATH = (env.PATH ?? "").split(delimiter).filter(isAbsolute).join(delimiter);
  return kept;
}

/**
 * The login-shell `PATH` without the worktree's directories, or an entry whose `command` is
 * something the repository ships, such as a symlink leading back in.
 */
async function machinePath(command: string, wtRoot: string): Promise<string> {
  const root = resolve(wtRoot);
  const entries = pathOutsideWorktree(buildSpawnEnv().PATH ?? "", root).split(delimiter);
  const usable = await Promise.all(entries.map((dir) => isUsableEntry(dir, command, root)));
  return entries.filter((_, i) => usable[i]).join(delimiter);
}

async function isUsableEntry(dir: string, command: string, root: string): Promise<boolean> {
  if (!isAbsolute(dir)) return false;
  const tool = Bun.which(command, { PATH: dir });
  if (!tool) return true;
  try {
    const [realTool, realRoot] = await Promise.all([realpath(tool), realpath(root)]);
    return !isInside(realTool, realRoot) && !(await isShippedByRepo(root, tool));
  } catch {
    return false;
  }
}

function csharpFailureNotice(failure: FormatterFailure): string | undefined {
  if (failure.kind === "not-installed") {
    return failure.command === CSHARPIER
      ? "Format on save skipped: this project uses CSharpier, which is not on your PATH. Install it with `dotnet tool install -g csharpier`."
      : undefined;
  }
  return isDotnet(failure.command) && failure.stderr.includes(NOT_RESTORED_HINT)
    ? "Format on save skipped: this project's CSharpier is not restored. Run `dotnet tool restore` in a terminal."
    : undefined;
}
