const MANIFEST_URL = "https://loxel.bizimind.io/loxel/manifest.json";
const FALLBACK_VERSION = "0.1.141";

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && v !== undefined && typeof v === "object";
}

export interface ManifestData {
  version: string;
  downloads: Record<string, string>;
}

export async function fetchManifest(): Promise<ManifestData> {
  const result: ManifestData = { version: FALLBACK_VERSION, downloads: {} };
  try {
    const manifest: unknown = await fetch(MANIFEST_URL).then((r) => r.json());
    if (isObj(manifest)) {
      if (typeof manifest.version === "string") result.version = manifest.version;
      if (isObj(manifest.app)) {
        for (const [platform, info] of Object.entries(manifest.app)) {
          if (isObj(info) && typeof info.url === "string") result.downloads[platform] = info.url;
        }
      }
    }
  } catch {
    // fall back to defaults
  }
  return result;
}
