import { createHash } from "node:crypto";
import { join } from "node:path";

import { DEFAULT_SERVER_PORT, parsePortEnv, vitePort } from "../app-ports";
import { demoPort, demoStateName, parseDemoInstance } from "../demo-instance";
import { cliSocketPath } from "../socket-paths";
import { STATE_BASE_DIR, stateDirFor } from "../state-dir";

const isDev = process.env.LOXEL_DEV === "1";
// Demo mode (`LOXEL_DEMO=1`): its own state and port, so a demo runs beside the app untouched.
// `LOXEL_DEMO_INSTANCE=<n>` runs several demos side by side, each with its own port and state.
const isDemo = process.env.LOXEL_DEMO === "1";

const demoInstance = isDemo ? parseDemoInstance(process.env.LOXEL_DEMO_INSTANCE) : 0;
const stateDir = isDemo
  ? (process.env.LOXEL_STATE_DIR ?? join(STATE_BASE_DIR, demoStateName(demoInstance)))
  : stateDirFor(isDev ? "dev" : "production");
const port =
  parsePortEnv("LOXEL_SERVE_PORT", process.env.LOXEL_SERVE_PORT) ??
  (isDemo
    ? demoPort(demoInstance)
    : isDev
      ? DEFAULT_SERVER_PORT.dev
      : DEFAULT_SERVER_PORT.production);

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

/** Drafts made in Home, which belong to no project: `<stateDir>/detached/home/`. */
export function getHomeDraftsDir(): string {
  return join(stateDir, "detached", "home");
}

export const config = {
  isDev,
  isDemo,
  stateDir,
  commentsDir: join(stateDir, "comments"),
  /** Tombi's `TOMBI_CACHE_HOME`; see `SchemaDownloads`. */
  tombiSchemaCacheDir: join(stateDir, "schema-cache", "tombi"),
  /** LemMinX's `xml.server.workDir`; see `SchemaDownloads`. */
  lemminxWorkDir: join(stateDir, "schema-cache", "lemminx"),
  /** Holds the `terraform` shim terraform-ls runs in a trusted repository; see `TerraformLspManager`. */
  terraformShimDir: join(stateDir, "terraform-ls"),
  port,
  /** The Unix socket the `loxel` CLI reaches this server on; see cli-socket.ts. */
  cliSocketPath: cliSocketPath(stateDir),
  /** The Vite dev server's port, whose origin a dev server also admits; null outside dev mode. */
  viteDevPort: isDev ? vitePort(process.env) : null,
  /**
   * The desktop app's process ID when the app started this server (`LOXEL_PARENT_PID`). The
   * server then lives as long as the app does; a server started on its own shuts down when idle.
   */
  parentPid,
  /** How long a worktree removed outside the app keeps its terminals; tests shorten it. */
  removedWorktreeTerminalDelayMs: Number(
    process.env.LOXEL_REMOVED_WORKTREE_TERMINAL_DELAY_MS ?? 60_000,
  ),
  /**
   * How long a worktree's resources outlive its last subscriber, so a reload, a network blip or a
   * quick look at another worktree keeps its undo history and caches; tests shorten it. Five
   * minutes, like an orphaned terminal's wait for its window: long enough for a window to come
   * back, short enough that idle watchers do not pile up.
   */
  worktreeGraceMs: Number(process.env.LOXEL_WORKTREE_GRACE_MS ?? 5 * 60_000),
} as const;
