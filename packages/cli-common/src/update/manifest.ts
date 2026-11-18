import type { KeyObject } from "node:crypto";

import { z } from "zod";

import {
  isManifestSignatureValid,
  MANIFEST_SIGNATURE_SUFFIX,
  releasePublicKey,
} from "./manifest-signature.ts";
import type { Platform } from "./platform.ts";

const BinaryInfoSchema = z.object({
  url: z.string().url(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

export const ManifestSchema = z.object({
  /** The CLI the manifest is for, signed with the rest so one CLI's manifest cannot pass for another's. */
  package: z.string(),
  version: z.string(),
  released_at: z.string(),
  binaries: z.record(z.string(), BinaryInfoSchema),
});

export type Manifest = z.infer<typeof ManifestSchema>;
export type BinaryInfo = z.infer<typeof BinaryInfoSchema>;

async function fetchOk(url: string, what: string): Promise<Response> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${what}: ${response.status} ${response.statusText}`);
  }
  return response;
}

/**
 * Fetch the manifest of `packageName`, check its release signature (published at the manifest URL
 * plus `.sig`), and validate it. A manifest without a valid signature is rejected before it is
 * parsed, and one for another package after.
 */
export async function fetchManifest(
  manifestUrl: string,
  packageName: string,
  publicKey: KeyObject = releasePublicKey(),
): Promise<Manifest> {
  const [manifestResponse, signatureResponse] = await Promise.all([
    fetchOk(manifestUrl, "update manifest"),
    fetchOk(`${manifestUrl}${MANIFEST_SIGNATURE_SUFFIX}`, "update manifest signature"),
  ]);
  const [body, signature] = await Promise.all([manifestResponse.bytes(), signatureResponse.text()]);

  if (!isManifestSignatureValid(body, signature, publicKey)) {
    throw new Error(`Refusing to update: ${manifestUrl} is not signed by the release key`);
  }

  const parsed = ManifestSchema.safeParse(JSON.parse(new TextDecoder().decode(body)));
  if (!parsed.success) {
    throw new Error(`Invalid manifest format: ${parsed.error.message}`);
  }
  if (parsed.data.package !== packageName) {
    throw new Error(
      `Refusing to update: ${manifestUrl} is the manifest of ${parsed.data.package}, not ${packageName}`,
    );
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
