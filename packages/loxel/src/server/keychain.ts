import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { config } from "./config";
import { logger } from "./logger";

const log = logger.child("keychain");

const KEY_ENCRYPTION_KEY = "com.bizimind.loxel.data-key-wrapper";
const WRAPPED_DEK_PATH = join(config.stateDir, "data-encryption-key.wrapped");
const KEY_BYTES = 32; // AES-256
const DEV_KEY = Buffer.from("loxel-dev-fixed-encryption-key!!", "utf8");

export async function loadOrCreateKey(): Promise<Buffer> {
  if (process.env.LOXEL_DEV === "1") {
    return DEV_KEY;
  }

  const { decryptWithKey, encryptWithKey } = await import("@bizimind/keychain");

  if (existsSync(WRAPPED_DEK_PATH)) {
    const key = decryptWithKey(KEY_ENCRYPTION_KEY, readFileSync(WRAPPED_DEK_PATH));
    if (key.length !== KEY_BYTES) {
      throw new Error(
        `Keychain unwrapped a key of unexpected length: ${key.length} bytes (expected ${KEY_BYTES})`,
      );
    }
    log.info("Loaded wrapped data encryption key");
    return key;
  }

  const key = randomBytes(KEY_BYTES);
  const wrapped = encryptWithKey(KEY_ENCRYPTION_KEY, key);
  mkdirSync(config.stateDir, { recursive: true });
  writeFileSync(WRAPPED_DEK_PATH, wrapped, { mode: 0o600 });
  log.info("Generated and wrapped new data encryption key");
  return key;
}
