const MANIFEST_URL = "https://loxel.bizimind.io/loxel/manifest.json";
// Only used by `astro dev` when the manifest is unreachable (e.g. offline)
const DEV_FALLBACK: ManifestData = { version: "0.0.0-dev", downloads: {} };

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && v !== undefined && typeof v === "object";
}

export interface ManifestData {
  version: string;
  downloads: Record<string, string>;
}

async function loadManifest(): Promise<ManifestData> {
  const res = await fetch(MANIFEST_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const manifest: unknown = await res.json();
  if (!isObj(manifest) || typeof manifest.version !== "string") {
    throw new Error("missing version");
  }
  const downloads: Record<string, string> = {};
  if (isObj(manifest.app)) {
    for (const [platform, info] of Object.entries(manifest.app)) {
      if (isObj(info) && typeof info.url === "string") downloads[platform] = info.url;
    }
  }
  return { version: manifest.version, downloads };
}

/**
 * Fetches the latest loxel release manifest at build time. Production builds fail on error so a
 * deploy never ships a stale version or missing download links; the last good deploy stays live.
 */
export async function fetchManifest(): Promise<ManifestData> {
  try {
    return await loadManifest();
  } catch (error) {
    if (!import.meta.env.DEV) {
      throw new Error(`Failed to load loxel manifest from ${MANIFEST_URL}`, { cause: error });
    }
    console.warn("Using dev fallback for loxel manifest:", error);
    return DEV_FALLBACK;
  }
}
