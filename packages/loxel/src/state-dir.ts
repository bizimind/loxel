/**
 * Where the server keeps its state when `LOXEL_STATE_DIR` does not say: one directory per mode
 * under `~/.local/state/loxel`, so dev, production and demo never share state, or a server. One
 * source of truth for the server (src/server/config.ts) and the `loxel` CLI, which finds a
 * server's socket there; demo directory names are in demo-instance.ts.
 */
import { homedir } from "node:os";
import { join, sep } from "node:path";

import { ensurePrivateDir } from "./socket-paths";

/** The directory every mode's state directory is in. */
export const STATE_BASE_DIR = join(homedir(), ".local", "state", "loxel");

/** The production and dev servers' default state directories. */
export const DEFAULT_STATE_DIR = {
  production: join(STATE_BASE_DIR, "loxel"),
  dev: join(STATE_BASE_DIR, "loxel-dev"),
} as const;

/** The state directory of a production or dev server: `LOXEL_STATE_DIR`, else the mode's default. */
export function stateDirFor(mode: keyof typeof DEFAULT_STATE_DIR, env = process.env): string {
  return env.LOXEL_STATE_DIR ?? DEFAULT_STATE_DIR[mode];
}

/**
 * Create `stateDir` private to this user (0700), or make an existing one private, and with it
 * {@link STATE_BASE_DIR} when `stateDir` is in it. Everything Loxel keeps there (drafts, layouts,
 * logs, databases) is then out of other accounts' reach, whatever mode its files were created
 * with. A state directory that links elsewhere is the user's own choice, so it is followed.
 */
export function ensurePrivateStateDir(stateDir: string, baseDir = STATE_BASE_DIR): void {
  if (stateDir.startsWith(baseDir + sep)) ensurePrivateDir(baseDir, { followLink: true });
  ensurePrivateDir(stateDir, { followLink: true });
}
