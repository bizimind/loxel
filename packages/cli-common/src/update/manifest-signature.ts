/**
 * Release manifests are signed with Ed25519, so trusting a manifest (and the SHA-256 of each
 * binary it lists) takes the release key, not only write access to the bucket that serves it.
 * Kept free of dependencies so the release workflow can run it without installing any.
 */
import { createPublicKey, verify, type KeyObject } from "node:crypto";

import { releasePublicKeyAtBuild } from "./release-key.ts" with { type: "macro" };

/**
 * The public half of the `CLI_MANIFEST_SIGNING_KEY` release secret, embedded at build time from
 * the `CLI_MANIFEST_PUBLIC_KEY` variable. Rotating the pair locks out every installed binary that
 * carries the old key: those can then only be updated by downloading a new release by hand.
 */
const RELEASE_PUBLIC_KEY = releasePublicKeyAtBuild();

/** The signature is published next to the manifest, at the manifest's URL plus this suffix. */
export const MANIFEST_SIGNATURE_SUFFIX = ".sig";

const ED25519_SIGNATURE_BYTES = 64;

/** An Ed25519 public key from its SPKI DER encoding in base64. */
export function publicKeyFromBase64(spkiBase64: string): KeyObject {
  const key = createPublicKey({
    key: Buffer.from(spkiBase64, "base64"),
    format: "der",
    type: "spki",
  });
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(`Expected an Ed25519 public key, got ${key.asymmetricKeyType}`);
  }
  return key;
}

/** The release public key this binary was built with. */
export function releasePublicKey(): KeyObject {
  if (!RELEASE_PUBLIC_KEY) {
    throw new Error(
      "Cannot verify updates: this build has no release public key (CLI_MANIFEST_PUBLIC_KEY was not set when it was built). Install a released binary instead.",
    );
  }
  return publicKeyFromBase64(RELEASE_PUBLIC_KEY);
}

/**
 * Whether `signature` (base64, as published in the `.sig` file) is a valid Ed25519 signature of
 * the exact manifest bytes by `publicKey`.
 */
export function isManifestSignatureValid(
  manifest: Uint8Array,
  signature: string,
  publicKey: KeyObject,
): boolean {
  const signatureBytes = Buffer.from(signature.trim(), "base64");
  if (signatureBytes.length !== ED25519_SIGNATURE_BYTES) return false;
  return verify(null, manifest, publicKey, signatureBytes);
}
