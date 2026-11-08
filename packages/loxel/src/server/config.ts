import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const isDev = process.env.LOXEL_DEV === "1";
const stateBase = join(homedir(), ".local", "state", "loxel");
const stateDir = process.env.LOXEL_STATE_DIR ?? join(stateBase, isDev ? "loxel-dev" : "loxel");
const port = process.env.LOXEL_SERVE_PORT
  ? parseInt(process.env.LOXEL_SERVE_PORT, 10)
  : isDev
    ? 7434
    : 7433;

/** A positive integer process ID from an environment variable, or null. */
function parsePid(value: string | undefined): number | null {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Read once and removed from the environment, so terminals and tools this server starts do not
 * inherit it: a server started from a Loxel terminal is not the app's.
 */
const parentPid = parsePid(process.env.LOXEL_PARENT_PID);
delete process.env.LOXEL_PARENT_PID;

/** First 12 hex chars of SHA-256 — short, stable, filesystem-safe. */
export function hash12(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 12);
}

/**
 * Detached files directory for a project+worktree scope.
 * Returns `<stateDir>/detached/<projectHash>/<wtHash>/`.
 */
export function getDetachedDir(projectPath: string, worktreePath: string | null): string {
  return join(stateDir, "detached", hash12(projectPath), hash12(worktreePath ?? projectPath));
}

export const config = {
  isDev,
  stateDir,
  commentsDir: join(stateDir, "comments"),
  port,
  /**
   * The desktop app's process ID when the app started this server (`LOXEL_PARENT_PID`). The
   * server then lives as long as the app does; a server started on its own shuts down when idle.
   */
  parentPid,
  /** How long a worktree removed outside the app keeps its terminals; tests shorten it. */
  removedWorktreeTerminalDelayMs: Number(
    process.env.LOXEL_REMOVED_WORKTREE_TERMINAL_DELAY_MS ?? 60_000,
  ),
} as const;
