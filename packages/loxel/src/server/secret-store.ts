import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { loadOrCreateKey } from "./keychain";
import { logger } from "./logger";

const log = logger.child("secret-store");
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const PREFIX = "enc:v1:";

let key: Buffer | null = null;

export async function initSecretStore(): Promise<void> {
  key = await loadOrCreateKey();
}

function requireKey(): Buffer {
  if (!key) throw new Error("Secret store not initialized — call initSecretStore() first");
  return key;
}

export function encrypt(plaintext: string): string {
  const k = requireKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, k, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const packed = Buffer.concat([iv, tag, encrypted]);
  return PREFIX + packed.toString("base64");
}

export function decrypt(ciphertext: string): string {
  if (!ciphertext.startsWith(PREFIX)) {
    log.warn("Attempted to decrypt a non-encrypted value — returning as-is");
    return ciphertext;
  }
  const k = requireKey();
  const packed = Buffer.from(ciphertext.slice(PREFIX.length), "base64");
  const iv = packed.subarray(0, IV_BYTES);
  const tag = packed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const encrypted = packed.subarray(IV_BYTES + TAG_BYTES);
  try {
    const decipher = createDecipheriv(ALGORITHM, k, iv);
    decipher.setAuthTag(tag);
    return decipher.update(encrypted, undefined, "utf8") + decipher.final("utf8");
  } catch {
    log.warn("Failed to decrypt value (key mismatch or corrupt data) — returning empty string");
    return "";
  }
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}
