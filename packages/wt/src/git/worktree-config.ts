/**
 * Per-worktree config (`extensions.worktreeConfig`).
 *
 * With the extension on, every worktree reads its own `config.worktree` on top
 * of the shared `config`, which is what `git config --worktree` writes to. The
 * main worktree's (or bare dir's) file is `<commonDir>/config.worktree`; a
 * linked worktree's is `<commonDir>/worktrees/<id>/config.worktree`.
 *
 * Turning the extension on is not just one setting. `core.bare = true` and
 * `core.worktree` describe the main worktree only, so git requires them in the
 * main `config.worktree` once the extension is on: left in the shared config,
 * every linked worktree inherits them, and in the bare layout each one fails
 * with "fatal: this operation must be run in a work tree". Enabling therefore
 * moves them first, and disabling moves them back.
 *
 * This module only reads state and computes the commands; it never changes a
 * repository on its own. Callers run the commands, and only on an explicit
 * user decision.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { git, runGit } from "./run.ts";
import { pathExists } from "./worktree.ts";

/** Main-worktree settings that must live in the main `config.worktree` while the extension is on. */
const MAIN_ONLY_KEYS = ["core.bare", "core.worktree"] as const;
export type MainOnlyKey = (typeof MAIN_ONLY_KEYS)[number];

export interface WorktreeConfigState {
  /** The repository's common git dir (absolute) */
  commonDir: string;
  /** `<commonDir>/config`, read by every worktree */
  sharedFile: string;
  /** `<commonDir>/config.worktree`, the main worktree's (or bare dir's) own file */
  mainFile: string;
  /** `extensions.worktreeConfig` is true */
  enabled: boolean;
  /** Main-only settings found in the shared config. `core.bare` is listed only when true. */
  shared: Partial<Record<MainOnlyKey, string>>;
  /** Main-only settings found in the main `config.worktree` */
  main: Partial<Record<MainOnlyKey, string>>;
  /**
   * Settings in each worktree's `config.worktree`, other than the main-only
   * ones this module moves: they apply only while the extension is on.
   */
  worktreeKeys: Array<{ file: string; keys: string[] }>;
}

/** Read where the extension and the main-only settings stand. Read-only. */
export async function readWorktreeConfigState(repoPath: string): Promise<WorktreeConfigState> {
  const commonDir = await gitCommonDir(repoPath);
  const sharedFile = join(commonDir, "config");
  const mainFile = join(commonDir, "config.worktree");

  const enabled = await isWorktreeConfigEnabled(commonDir);

  const shared: WorktreeConfigState["shared"] = {};
  if ((await readConfig(commonDir, sharedFile, "core.bare", "bool")) === "true") {
    shared["core.bare"] = "true";
  }
  const sharedWorktree = await readConfig(commonDir, sharedFile, "core.worktree");
  if (sharedWorktree !== null) shared["core.worktree"] = sharedWorktree;

  const main: WorktreeConfigState["main"] = {};
  for (const key of MAIN_ONLY_KEYS) {
    const value = await readConfig(commonDir, mainFile, key);
    if (value !== null) main[key] = value;
  }

  return {
    commonDir,
    sharedFile,
    mainFile,
    enabled,
    shared,
    main,
    worktreeKeys: await readWorktreeKeys(commonDir, mainFile),
  };
}

/** The repository's common git dir (absolute), from any path inside it. */
export function gitCommonDir(repoPath: string): Promise<string> {
  return git(["rev-parse", "--path-format=absolute", "--git-common-dir"], repoPath);
}

/** Whether `extensions.worktreeConfig` is on. Reads only the shared config, one git call. */
export async function isWorktreeConfigEnabled(commonDir: string): Promise<boolean> {
  const sharedFile = join(commonDir, "config");
  return (await readConfig(commonDir, sharedFile, "extensions.worktreeConfig", "bool")) === "true";
}

/**
 * Whether linked worktrees are broken: the extension is on but a main-only
 * setting is still in the shared config, so every worktree inherits it.
 */
export function isWorktreeConfigBroken(state: WorktreeConfigState): boolean {
  return state.enabled && Object.keys(state.shared).length > 0;
}

/**
 * Whether the extension is off but main-only settings are still only in the
 * main `config.worktree`, which git does not read then: an interrupted enable
 * or disable. Git itself copes (it guesses a bare repo), but tools that read
 * `core.bare` may not.
 */
export function isWorktreeConfigStranded(state: WorktreeConfigState): boolean {
  return strandedWorktreeConfigKeys(state).length > 0;
}

/**
 * The main-only settings stranded that way: in the main file but not the
 * shared one. A key in both is fine, since git reads the shared copy.
 */
export function strandedWorktreeConfigKeys(state: WorktreeConfigState): MainOnlyKey[] {
  if (state.enabled) return [];
  return MAIN_ONLY_KEYS.filter(
    (key) => state.main[key] !== undefined && state.shared[key] === undefined,
  );
}

/**
 * Git arguments (run in `commonDir`) that turn the extension on, moving the
 * main-only settings out of the shared config first. Empty when it is already
 * on and healthy, so running the result is idempotent; it also repairs the
 * broken state.
 *
 * Order matters: each setting is copied to the main file and removed from the
 * shared one before the extension is switched on, so at no point does a
 * linked worktree see `core.bare = true` with the extension on.
 */
export function enableWorktreeConfigCommands(state: WorktreeConfigState): string[][] {
  const commands: string[][] = [];
  for (const key of MAIN_ONLY_KEYS) {
    const value = state.shared[key];
    if (value === undefined) continue;
    commands.push(
      ["config", "--file", state.mainFile, "--replace-all", key, value],
      ["config", "--file", state.sharedFile, "--unset-all", key],
    );
  }
  if (!state.enabled) {
    commands.push(["config", "--file", state.sharedFile, "extensions.worktreeConfig", "true"]);
  }
  return commands;
}

/**
 * Git arguments (run in `commonDir`) that turn the extension off and move the
 * main-only settings back into the shared config. Empty when it is already
 * off and the settings are where they belong; when it is off but they are
 * still only in the (now unread) main file, as an interrupted enable or
 * disable leaves them, this moves them back too. Other settings in
 * `config.worktree` files are left in place, unread until the extension is
 * turned on again.
 *
 * The extension goes off first: while it is on, `core.bare = true` in the
 * shared config would break the linked worktrees.
 */
export function disableWorktreeConfigCommands(state: WorktreeConfigState): string[][] {
  const commands: string[][] = state.enabled
    ? [["config", "--file", state.sharedFile, "--unset-all", "extensions.worktreeConfig"]]
    : [];
  for (const key of MAIN_ONLY_KEYS) {
    const value = state.main[key];
    if (value === undefined) continue;
    commands.push(
      ["config", "--file", state.sharedFile, "--replace-all", key, value],
      ["config", "--file", state.mainFile, "--unset-all", key],
    );
  }
  return commands;
}

/** One key from one config file, or null when it is not set (or the file does not exist). */
async function readConfig(
  cwd: string,
  file: string,
  key: string,
  type?: "bool",
): Promise<string | null> {
  const typeArgs = type ? [`--type=${type}`] : [];
  const result = await runGit(["config", "--file", file, ...typeArgs, "--get", key], cwd);
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

/** Keys set in each existing `config.worktree`, minus the main-only ones in the main file. */
async function readWorktreeKeys(
  commonDir: string,
  mainFile: string,
): Promise<WorktreeConfigState["worktreeKeys"]> {
  const linkedRoot = join(commonDir, "worktrees");
  const linked = (await pathExists(linkedRoot)) ? await readdir(linkedRoot) : [];
  const files = [mainFile, ...linked.map((id) => join(linkedRoot, id, "config.worktree"))];

  const found: WorktreeConfigState["worktreeKeys"] = [];
  for (const file of files) {
    if (!(await pathExists(file))) continue;
    const result = await runGit(["config", "--file", file, "--name-only", "--list"], commonDir);
    if (result.exitCode !== 0) continue;
    const keys = result.stdout
      .split("\n")
      .map((key) => key.trim())
      .filter((key) => key && !(file === mainFile && isMainOnlyKey(key)));
    if (keys.length > 0) found.push({ file, keys });
  }
  return found;
}

function isMainOnlyKey(key: string): boolean {
  return MAIN_ONLY_KEYS.some((mainKey) => mainKey === key.toLowerCase());
}
