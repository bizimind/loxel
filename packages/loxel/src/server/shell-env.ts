import { homedir } from "node:os";
import { join } from "node:path";

import { logger } from "./logger";

const log = logger.child("server");

/** Resolved PATH from the user's login shell */
let resolvedPath: string | null = null;

/**
 * Resolve the user's login shell PATH.
 *
 * macOS apps launched from /Applications (Finder, Dock) inherit a minimal
 * launchd environment that lacks PATH additions from .zshrc/.bashrc (e.g.,
 * nvm, mise, homebrew). This runs the user's login shell to capture the
 * full PATH, so hook scripts can find tools like bun/npm.
 *
 * Call once at server startup.
 */
export async function resolveLoginShellEnv(): Promise<void> {
  const shell = process.env.SHELL || "/bin/zsh";
  try {
    // Use sentinels to extract PATH even if the shell prints motd/greeting noise
    const sentinel = "__LOXEL_PATH__";
    const proc = Bun.spawn([shell, "-ilc", `echo ${sentinel}\${PATH}${sentinel}`], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();

    const match = stdout.match(new RegExp(`${sentinel}(.+?)${sentinel}`));
    if (exitCode === 0 && match?.[1]) {
      resolvedPath = match[1];
      log.info("Resolved login shell PATH");
    } else {
      log.warn("Could not resolve login shell PATH", { shell, exitCode });
    }
  } catch (err) {
    log.warn("Failed to resolve login shell PATH", { error: err });
  }
}

/**
 * Build an env object suitable for spawning child processes.
 * Applies resolved PATH from login shell, ensures ~/.local/bin is present,
 * and guarantees HOME is set.
 */
export function buildSpawnEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  if (resolvedPath) {
    env.PATH = resolvedPath;
  }
  const localBin = join(homedir(), ".local", "bin");
  if (!env.PATH || !env.PATH.split(":").includes(localBin)) {
    env.PATH = env.PATH ? `${localBin}:${env.PATH}` : localBin;
  }
  if (!env.HOME) {
    env.HOME = homedir();
  }
  return env;
}
