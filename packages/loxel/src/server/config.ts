import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const isDev = process.env.LOXEL_DEV === "1";
const stateBase = join(homedir(), ".local", "state", "loxel");
const stateDir = join(stateBase, isDev ? "loxel-dev" : "loxel");

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
  updatesDir: join(stateDir, "updates"),
  port: isDev ? 7434 : 7433,
} as const;
