// TODO: temporary — unused imports and constants kept for easy revert
// import { decryptWithKey, encryptWithKey } from "@bizimind/keychain";
// import { randomBytes } from "node:crypto";
// import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
// import { join } from "node:path";
// import { config } from "./config";
// import { logger } from "./logger";
// const log = logger.child("keychain");
// const KEY_ENCRYPTION_KEY = "com.bizimind.loxel.data-key-wrapper";
// const WRAPPED_DEK_PATH = join(config.stateDir, "data-encryption-key.wrapped");
// const KEY_BYTES = 32; // AES-256

const DEV_KEY = Buffer.from("loxel-dev-fixed-encryption-key!!", "utf8");

export async function loadOrCreateKey(): Promise<Buffer> {
  // TODO: temporary — bypassing keychain, revert to restore production key wrapping
  return DEV_KEY;
}
