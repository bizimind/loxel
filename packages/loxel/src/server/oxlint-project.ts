/** What a worktree says about oxlint, read from disk without running anything. */
import { existsSync } from "node:fs";
import path from "node:path";

import {
  hasInstalledPackage,
  isFile,
  namesDependency,
  notInstalledMessage,
  projectDirs,
  readPackageJson,
} from "./js-project";
import {
  nearestAbove,
  owningRepo,
  type ProjectScan,
  scanProject,
  type ScanOptions,
} from "./project-scan";

export const OXLINT_PACKAGE = "oxlint";

/** The names oxlint loads a config from, per directory. Checked against 1.86.0. */
const CONFIG_FILES = [".oxlintrc.json", ".oxlintrc.jsonc", "oxlint.config.ts", "oxlint.config.mts"];

/** What oxlint runs for its type-aware rules, found from its workspace root upward. */
const TYPE_CHECKER = path.join("node_modules", ".bin", "tsgolint");

export function isOxlintConfigFile(file: string): boolean {
  return CONFIG_FILES.includes(path.basename(file));
}

function holdsConfig(dir: string): boolean {
  return CONFIG_FILES.some((name) => existsSync(path.join(dir, name)));
}

/** The nearest directory from `file` up to the worktree saying that its project uses oxlint. */
export function findOxlintProjectDir(file: string, wtPath: string): string | null {
  for (const dir of projectDirs(file, wtPath)) {
    if (CONFIG_FILES.some((name) => isFile(path.join(dir, name)))) return dir;
    if (namesDependency(readPackageJson(dir), OXLINT_PACKAGE)) return dir;
  }
  return null;
}

/** Whether oxlint would lint `file` the way the terminal does: its project uses it, and has it. */
export function isOxlintFile(file: string, wtPath: string): boolean {
  return (
    findOxlintProjectDir(file, wtPath) !== null && hasInstalledPackage(OXLINT_PACKAGE, file, wtPath)
  );
}

/** What to tell the user about a project that uses oxlint without having it installed. */
export function oxlintNotInstalledMessage(projectDir: string, wtPath: string): string {
  return notInstalledMessage(
    { name: "oxlint", packageName: OXLINT_PACKAGE, sign: "uses oxlint" },
    projectDir,
    wtPath,
  );
}

/** What a server for this worktree would run and load. */
export interface OxlintWorktreeScan extends Omit<ProjectScan, "usesTool"> {
  /** Whether a config or a dependency outside nested repositories says the worktree uses oxlint. */
  usesOxlint: boolean;
  /** The directories whose trust covers what oxlint would use from above the worktree. */
  ancestorRepos: string[];
}

/**
 * oxlint's start reads every config it can see below its root, nested repositories and the targets
 * of symbolic links included, and looks above its root for what the root does not have. It skips
 * what `.gitignore` covers.
 */
export async function scanWorktree(
  wtPath: string,
  options: ScanOptions = {},
): Promise<OxlintWorktreeScan> {
  const { usesTool, ...scan } = await scanProject(
    wtPath,
    {
      configFiles: CONFIG_FILES,
      packageName: OXLINT_PACKAGE,
      skipsIgnored: true,
      followsLinks: true,
    },
    options,
  );
  return { ...scan, usesOxlint: usesTool, ancestorRepos: findAncestorRepos(wtPath) };
}

/** With none of its own in the worktree, oxlint looks upward for a config and for its type checker. */
function findAncestorRepos(wtPath: string): string[] {
  const hasOwnConfig = CONFIG_FILES.some((name) => isFile(path.join(wtPath, name)));
  const hasOwnTypeChecker = isFile(path.join(wtPath, TYPE_CHECKER));
  const found = [
    hasOwnConfig ? null : nearestAbove(wtPath, holdsConfig),
    hasOwnTypeChecker
      ? null
      : nearestAbove(wtPath, (dir) => existsSync(path.join(dir, TYPE_CHECKER))),
  ];
  return [...new Set(found.flatMap((dir) => (dir ? [owningRepo(dir)] : [])))];
}
