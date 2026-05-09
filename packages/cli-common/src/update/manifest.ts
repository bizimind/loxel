import { z } from "zod";

import type { Platform } from "./platform.ts";

const BinaryInfoSchema = z.object({ url: z.string().url(), sha256: z.string() });

export const ManifestSchema = z.object({
  version: z.string(),
  released_at: z.string(),
  binaries: z.record(z.string(), BinaryInfoSchema),
});

export type Manifest = z.infer<typeof ManifestSchema>;
export type BinaryInfo = z.infer<typeof BinaryInfoSchema>;

/**
 * Fetch and validate a manifest from the given URL.
 */
export async function fetchManifest(manifestUrl: string): Promise<Manifest> {
  const response = await fetch(manifestUrl);

  if (!response.ok) {
    throw new Error(`Failed to fetch update manifest: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  const parsed = ManifestSchema.safeParse(data);

  if (!parsed.success) {
    throw new Error(`Invalid manifest format: ${parsed.error.message}`);
  }

  return parsed.data;
}

/**
 * Get binary info for a specific platform from a manifest.
 */
export function getBinaryInfo(manifest: Manifest, platform: Platform): BinaryInfo {
  const binaryInfo = manifest.binaries[platform];

  if (!binaryInfo) {
    throw new Error(`No binary available for platform: ${platform}`);
  }

  return binaryInfo;
}
