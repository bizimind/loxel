import { mkdir } from "node:fs/promises";
import { z } from "zod";

import { compareVersions } from "./checker.ts";
import { fetchManifest, type Manifest } from "./manifest.ts";

const DEFAULT_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

const CacheSchema = z.object({ last_check: z.string(), latest_version: z.string() });

type Cache = z.infer<typeof CacheSchema>;

export interface CacheConfig {
  /** Full path to the cache file (e.g., ~/.local/state/loxel/wt/update-cache.json) */
  cacheFile: string;
  /** Cache TTL in milliseconds (default: 1 hour) */
  cacheTtlMs?: number;
}

export interface CachedUpdateCheckResult {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion: string;
  manifest?: Manifest;
}

async function readCache(cacheFile: string): Promise<Cache | null> {
  try {
    const file = Bun.file(cacheFile);
    if (!(await file.exists())) return null;

    const data = await file.json();
    const parsed = CacheSchema.safeParse(data);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function writeCache(cacheFile: string, cache: Cache): Promise<void> {
  try {
    const dir = cacheFile.substring(0, cacheFile.lastIndexOf("/"));
    await mkdir(dir, { recursive: true });
    await Bun.write(cacheFile, JSON.stringify(cache, null, 2));
  } catch {
    // Ignore cache write failures
  }
}

/**
 * Check for updates with caching support.
 */
export async function checkForUpdatesWithCache(
  manifestUrl: string,
  currentVersion: string,
  config: CacheConfig,
  options?: { skipCache?: boolean },
): Promise<CachedUpdateCheckResult> {
  const cacheTtlMs = config.cacheTtlMs ?? DEFAULT_CHECK_INTERVAL_MS;

  // Check cache first
  if (!options?.skipCache) {
    const cache = await readCache(config.cacheFile);
    if (cache) {
      const lastCheck = new Date(cache.last_check).getTime();
      const now = Date.now();

      if (now - lastCheck < cacheTtlMs) {
        const hasUpdate = compareVersions(cache.latest_version, currentVersion) > 0;
        return { hasUpdate, currentVersion, latestVersion: cache.latest_version };
      }
    }
  }

  // Fetch fresh manifest
  const manifest = await fetchManifest(manifestUrl);

  // Update cache
  await writeCache(config.cacheFile, {
    last_check: new Date().toISOString(),
    latest_version: manifest.version,
  });

  const hasUpdate = compareVersions(manifest.version, currentVersion) > 0;

  return { hasUpdate, currentVersion, latestVersion: manifest.version, manifest };
}

/**
 * Check if we should check for updates based on cache TTL.
 */
export async function shouldCheckForUpdates(config: CacheConfig): Promise<boolean> {
  const cacheTtlMs = config.cacheTtlMs ?? DEFAULT_CHECK_INTERVAL_MS;
  const cache = await readCache(config.cacheFile);

  if (!cache) return true;

  const lastCheck = new Date(cache.last_check).getTime();
  const now = Date.now();

  return now - lastCheck >= cacheTtlMs;
}
