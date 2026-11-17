/**
 * Where the server keeps its state when `LOXEL_STATE_DIR` does not say: one directory per mode
 * under `~/.local/state/loxel`, so dev, production and demo never share state, or a server. One
 * source of truth for the server (src/server/config.ts) and the `loxel` CLI, which finds a
 * server's socket there; demo directory names are in demo-instance.ts.
 */
import { homedir } from "node:os";
import { join } from "node:path";

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
