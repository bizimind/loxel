import { fetchManifest, type Manifest } from "./manifest.ts";

export interface UpdateCheckResult {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion: string;
  manifest?: Manifest;
}

/**
 * Compare two semver-like version strings.
 * Returns > 0 if a > b, < 0 if a < b, 0 if equal.
 */
export function compareVersions(a: string, b: string): number {
  const partsA = a.split(".").map(Number);
  const partsB = b.split(".").map(Number);

  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const numA = partsA[i] ?? 0;
    const numB = partsB[i] ?? 0;
    if (numA !== numB) return numA - numB;
  }

  return 0;
}

/**
 * Check for updates by comparing current version against manifest.
 */
export async function checkForUpdates(
  manifestUrl: string,
  currentVersion: string,
): Promise<UpdateCheckResult> {
  const manifest = await fetchManifest(manifestUrl);
  const hasUpdate = compareVersions(manifest.version, currentVersion) > 0;

  return { hasUpdate, currentVersion, latestVersion: manifest.version, manifest };
}
