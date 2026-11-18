import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  checkForUpdatesWithCache,
  recordUpdateCheck,
  shouldCheckForUpdates,
  type CacheConfig,
} from "./cache.ts";
import { checkForUpdates, type UpdateCheckResult } from "./checker.ts";
import { fetchManifest, type Manifest } from "./manifest.ts";
import { getCurrentPlatform } from "./platform.ts";
import { isRunningCompiled, performUpdate } from "./updater.ts";

// Re-export all types and functions
export { checkForUpdates, compareVersions, type UpdateCheckResult } from "./checker.ts";
export {
  checkForUpdatesWithCache,
  shouldCheckForUpdates,
  type CacheConfig,
  type CachedUpdateCheckResult,
} from "./cache.ts";
export {
  fetchManifest,
  getBinaryInfo,
  ManifestSchema,
  type BinaryInfo,
  type Manifest,
} from "./manifest.ts";
export { getCurrentPlatform, type Platform } from "./platform.ts";
export {
  downloadAndVerify,
  isRunningCompiled,
  performUpdate,
  type PerformUpdateOptions,
} from "./updater.ts";

/**
 * Configuration for a CLI's update system.
 */
export interface UpdateConfig {
  /** The package name (e.g., "wt", "code-analysis") */
  packageName: string;
  /** Full manifest URL or auto-derived from packageName if not specified */
  manifestUrl?: string;
  /** Function to get the current version */
  getCurrentVersion: () => string;
  /** Enable caching (like wt) or always fetch fresh */
  cacheEnabled?: boolean;
  /** Cache directory (defaults to ~/.local/state/loxel/<packageName>) */
  cacheDir?: string;
  /** Cache TTL in milliseconds (default: 1 hour) */
  cacheTtlMs?: number;
}

const BASE_URL = "https://loxel.bizimind.io";

function getManifestUrl(config: UpdateConfig): string {
  return config.manifestUrl ?? `${BASE_URL}/${config.packageName}/manifest.json`;
}

function getCacheConfig(config: UpdateConfig): CacheConfig {
  const cacheDir =
    config.cacheDir ?? join(homedir(), ".local", "state", "loxel", config.packageName);
  return { cacheFile: join(cacheDir, "update-cache.json"), cacheTtlMs: config.cacheTtlMs };
}

/**
 * Create an update system for a CLI package.
 */
export function createUpdateSystem(config: UpdateConfig) {
  const manifestUrl = getManifestUrl(config);
  const cacheConfig = getCacheConfig(config);

  return {
    /**
     * Check for available updates.
     */
    checkForUpdates: async (options?: { skipCache?: boolean }): Promise<UpdateCheckResult> => {
      const currentVersion = config.getCurrentVersion();

      if (config.cacheEnabled) {
        return checkForUpdatesWithCache(
          manifestUrl,
          config.packageName,
          currentVersion,
          cacheConfig,
          options,
        );
      }

      return checkForUpdates(manifestUrl, config.packageName, currentVersion);
    },

    /**
     * Fetch the manifest.
     */
    fetchManifest: () => fetchManifest(manifestUrl, config.packageName),

    /**
     * Perform the update.
     */
    performUpdate: (manifest: Manifest) =>
      performUpdate(manifest, { packageName: config.packageName }),

    /**
     * Check if running as a compiled binary.
     */
    isRunningCompiled,

    /**
     * Get current version.
     */
    getCurrentVersion: config.getCurrentVersion,

    /**
     * Get current platform.
     */
    getCurrentPlatform,

    /**
     * Check if should check for updates (respects cache TTL).
     */
    shouldCheckForUpdates: () =>
      config.cacheEnabled ? shouldCheckForUpdates(cacheConfig) : Promise.resolve(true),
  };
}

export interface MaybeAutoUpdateConfig extends UpdateConfig {
  /** Commands that should skip auto-update (e.g., ["version", "update", "--version", "-V"]) */
  skipCommands?: string[];
  /** Function to check if auto-update is enabled (e.g., check config file) */
  isAutoUpdateEnabled?: () => Promise<boolean>;
}

/**
 * Perform auto-update if conditions are met (like wt's maybeAutoUpdate).
 * Returns true if an update was performed and the command already re-ran on the new binary, whose
 * exit status is then in `process.exitCode`.
 */
export async function maybeAutoUpdate(
  config: MaybeAutoUpdateConfig,
  argv: string[],
): Promise<boolean> {
  const skipCommands = config.skipCommands ?? ["version", "update", "--version", "-V"];

  // Skip auto-update for certain commands
  const args = argv.slice(2);
  if (args[0] && skipCommands.includes(args[0])) {
    return false;
  }

  // Check if auto-update is enabled
  if (config.isAutoUpdateEnabled && !(await config.isAutoUpdateEnabled())) {
    return false;
  }

  const updateSystem = createUpdateSystem({ ...config, cacheEnabled: true });

  // Check if we should check (respects cache TTL)
  if (!(await updateSystem.shouldCheckForUpdates())) {
    return false;
  }

  try {
    const updateInfo = await updateSystem.checkForUpdates();
    if (!updateInfo.hasUpdate) {
      return false;
    }

    process.stderr.write(
      `Updating ${config.packageName} from ${updateInfo.currentVersion} to ${updateInfo.latestVersion}...\n`,
    );

    const manifest = updateInfo.manifest ?? (await updateSystem.fetchManifest());
    await updateSystem.performUpdate(manifest);
  } catch (err) {
    // Best effort: the command runs on the installed binary, and the next attempt waits for the
    // cache TTL instead of failing every command. `<cli> update` reports the failure in full.
    const message = err instanceof Error ? err.message.split("\n", 1)[0] : String(err);
    process.stderr.write(
      `Automatic update of ${config.packageName} failed: ${message}\nRun \`${config.packageName} update\` to retry.\n`,
    );
    await recordUpdateCheck(getCacheConfig(config), config.getCurrentVersion());
    return false;
  }

  process.stderr.write("Update complete. Re-running command...\n");

  // Re-exec the current command with the new binary, passing on its exit status. process.execPath
  // is the real file; argv[0] is "bun" and argv[1] the bundle's internal "/$bunfs/root/..." path,
  // so only the arguments after them are the command's. Array args: no shell, no injection.
  const result = spawnSync(process.execPath, argv.slice(2), { stdio: "inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;

  return true;
}
