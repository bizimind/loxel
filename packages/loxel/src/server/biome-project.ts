/** What a worktree says about Biome's linter, read from disk without running anything. */
import { lstatSync, mkdirSync } from "node:fs";
import path from "node:path";

import { isRecord } from "@/lib/is-record";

import { readConfigFile } from "./config-file-read";
import { biomeNativeDir } from "./js-formatter";
import { isFile, notInstalledMessage } from "./js-project";
import {
  nearestAbove,
  owningRepo,
  type ProjectScan,
  scanProject,
  type ScanOptions,
} from "./project-scan";

export const BIOME_PACKAGE = "@biomejs/biome";

/** The names Biome loads a config from, in the order it prefers them. Checked against 2.6.4. */
const CONFIG_FILES = ["biome.json", "biome.jsonc", ".biome.json", ".biome.jsonc"];

export function isBiomeConfigFile(file: string): boolean {
  return CONFIG_FILES.includes(path.basename(file));
}

function configIn(dir: string): string | undefined {
  return CONFIG_FILES.map((name) => path.join(dir, name)).find(isFile);
}

/**
 * Whether the worktree's root has a config, which is what starts the server: with the worktree as
 * its workspace, Biome lints nothing when only a package below has one.
 */
export function hasBiomeConfig(wtPath: string): boolean {
  return configIn(wtPath) !== undefined;
}

/**
 * Whether the root's config leaves the search going upward. One that cannot be read or parsed
 * counts, so that a decision never rests on a config Biome may read differently.
 */
function looksAboveWorktree(wtPath: string): boolean {
  const config = configIn(wtPath);
  const text = config && readConfigFile(config);
  if (text === undefined) return true;
  try {
    const parsed: unknown = Bun.JSONC.parse(text);
    return !isRecord(parsed) || parsed.root === false;
  } catch {
    return true;
  }
}

/** What a server for this worktree would run and load. */
export interface BiomeWorktreeScan extends Omit<ProjectScan, "usesTool"> {
  /** The directory whose trust covers the config Biome would use from above the worktree. */
  ancestorRepo: string | null;
}

/**
 * Biome's start reads every config below its root, nested repositories included, and with
 * `root: false` at the worktree's root the nearest above it. It reads only the root's `.gitignore`
 * and only with `vcs.useIgnoreFile`, so what git ignores is walked too. It does not enter symbolic
 * links.
 */
export async function scanBiomeWorktree(
  wtPath: string,
  options: ScanOptions = {},
): Promise<BiomeWorktreeScan> {
  const { usesTool: _, ...scan } = await scanProject(
    wtPath,
    {
      configFiles: CONFIG_FILES,
      packageName: BIOME_PACKAGE,
      skipsIgnored: false,
      followsLinks: false,
    },
    options,
  );
  const above = looksAboveWorktree(wtPath)
    ? nearestAbove(wtPath, (dir) => configIn(dir) !== undefined)
    : null;
  return { ...scan, ancestorRepo: above && owningRepo(above) };
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
 * A home of `key`'s own, so that its daemon is its own. Biome keeps one daemon per version per home,
 * whichever binary asks, so a daemon started from one repository's install would serve another's.
 *
 * Under `/tmp` because the daemon's socket lies about 65 characters below this, and a socket's path
 * must fit in about 104: the state and temporary directories are too long on macOS. Since others
 * can write to `/tmp`, a directory that is not this user's own counts as none.
 */
export function biomeDaemonHome(key: string): string | null {
  const uid = process.getuid?.();
  if (uid === undefined) return null;
  const home = `/tmp/lxb-${uid}-${Bun.hash(key).toString(36).slice(0, 8)}`;
  try {
    mkdirSync(home, { mode: 0o700 });
  } catch (err) {
    if (!isRecord(err) || err.code !== "EEXIST") return null;
  }
  const stat = lstatSync(home);
  return stat.isDirectory() && stat.uid === uid && (stat.mode & 0o077) === 0 ? home : null;
}
