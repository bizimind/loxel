/** What a worktree says about Biome's linter, read from disk without running anything. */
import { mkdtempSync } from "node:fs";
import path from "node:path";

import { isRecord } from "@/lib/is-record";

import { readConfigFile } from "./config-file-read";
import { BIOME_CONFIG_FILES, biomeNativeDir } from "./js-formatter";
import { isFile, namesDependency, notInstalledMessage, readPackageJson } from "./js-project";
import {
  nearestAbove,
  owningRepo,
  type ProjectScan,
  scanProject,
  type ScanOptions,
} from "./project-scan";

export const BIOME_PACKAGE = "@biomejs/biome";

export function isBiomeConfigFile(file: string): boolean {
  return BIOME_CONFIG_FILES.includes(path.basename(file));
}

function configIn(dir: string): string | undefined {
  return BIOME_CONFIG_FILES.map((name) => path.join(dir, name)).find(isFile);
}

/**
 * Whether the worktree's root has a config, which is what starts the server: with the worktree as
 * its workspace, Biome lints nothing when only a package below has one.
 */
export function hasBiomeConfig(wtPath: string): boolean {
  return configIn(wtPath) !== undefined;
}

/**
 * Whether the config in `dir` leaves the search going upward: `root: false`, or `extends: "//"`,
 * which implies it. One that cannot be read or parsed counts, so that a decision never rests on a
 * config Biome may read differently.
 */
function looksAbove(dir: string): boolean {
  const config = configIn(dir);
  const text = config && readConfigFile(config);
  if (text === undefined) return true;
  try {
    const parsed: unknown = Bun.JSONC.parse(text);
    if (!isRecord(parsed) || parsed.root === false) return true;
    const { extends: extended } = parsed;
    return extended === "//" || (Array.isArray(extended) && extended.includes("//"));
  } catch {
    return true;
  }
}

/** The repositories of the configs Biome would go through above the worktree, to the first root. */
function findAncestorRepos(wtPath: string): string[] {
  const repos = new Set<string>();
  let dir: string | null = wtPath;
  while (dir && looksAbove(dir)) {
    dir = nearestAbove(dir, (candidate) => configIn(candidate) !== undefined);
    if (dir) repos.add(owningRepo(dir));
  }
  return [...repos];
}

/** What a server for this worktree would run and load. */
export interface BiomeWorktreeScan extends Omit<ProjectScan, "usesTool"> {
  /** The directories whose trust covers the configs Biome would use from above the worktree. */
  ancestorRepos: string[];
}

/**
 * Biome's start reads every config below its root, nested repositories included, and with a root
 * config that defers upward, those above it too. It reads only the root's `.gitignore` and only with
 * `vcs.useIgnoreFile`, so what git ignores is walked too. It does not enter symbolic links.
 */
export async function scanBiomeWorktree(
  wtPath: string,
  options: ScanOptions = {},
): Promise<BiomeWorktreeScan> {
  const { usesTool: _, ...scan } = await scanProject(
    wtPath,
    {
      configFiles: BIOME_CONFIG_FILES,
      packageName: BIOME_PACKAGE,
      skipsIgnored: false,
      followsLinks: false,
    },
    options,
  );
  return { ...scan, ancestorRepos: findAncestorRepos(wtPath) };
}

/**
 * The install to run: the nearest to the root, at the root or where a manifest asks for it. Since
 * the walk covers what git ignores, any other is a fixture or a leftover, not the project's Biome.
 */
export function findBiomeInstall(installDirs: readonly string[], wtPath: string): string | null {
  const found = installDirs.find(
    (dir) => dir === wtPath || namesDependency(readPackageJson(dir), BIOME_PACKAGE),
  );
  return found ?? null;
}

/** The platform binary an install at `dir` runs; its `.bin` entry is a Node script around this. */
export function biomeBinary(dir: string): string | null {
  const nativeDir = biomeNativeDir(dir);
  return nativeDir && Bun.which("biome", { PATH: nativeDir });
}

/** What to tell the user about a project with a Biome config and no Biome. */
export function biomeNotInstalledMessage(wtPath: string): string {
  return notInstalledMessage(
    { name: "Biome", packageName: BIOME_PACKAGE, sign: "has a Biome config" },
    wtPath,
    wtPath,
  );
}

/**
 * A new home for one session's daemon, as Biome keeps one daemon per version per home. Under `/tmp`
 * because the daemon's socket lies about 65 characters below it and a socket's path must fit in
 * about 104, which the state and temporary directories leave no room for on macOS.
 */
export function createBiomeDaemonHome(): string {
  return mkdtempSync("/tmp/lxb-");
}
