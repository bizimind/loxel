import { getSecret, setSecret } from "@bizimind/keychain";
import { randomBytes } from "node:crypto";

import { logger } from "./logger";

const log = logger.child("keychain");

const SERVICE = "com.bizimind.loxel";
const ACCOUNT = "encryption-key";
const KEY_BYTES = 32; // AES-256

export function loadOrCreateKey(): Buffer {
  const existing = getSecret(SERVICE, ACCOUNT);
  if (existing) {
    if (existing.length !== KEY_BYTES) {
      throw new Error(
        `Keychain returned a key of unexpected length: ${existing.length} bytes (expected ${KEY_BYTES})`,
      );
    }
    log.info("Loaded encryption key from Keychain");
    return existing;
  }

  const key = randomBytes(KEY_BYTES);
  setSecret(SERVICE, ACCOUNT, key);
  log.info("Generated and stored new encryption key in Keychain");
  return key;
}
