import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { safeStorage } from "electron";

import { IS_DEV } from "./env";

const STATE_DIR =
  process.env.LOXEL_STATE_DIR ??
  path.join(os.homedir(), ".local", "state", "loxel", IS_DEV ? "loxel-dev" : "loxel");
const DEK_FILE = path.join(STATE_DIR, "data-encryption-key.enc");

let cached: string | null = null;

/**
 * The data encryption key to hand the server, or null when the system keychain can't protect one.
 * Loxel runs without it: the server then reports secret storage as unavailable.
 */
export function loadOrCreateDek(): string | null {
  if (cached) return cached;

  if (!safeStorage.isEncryptionAvailable()) {
    console.warn("[electron] System keychain encryption is unavailable; no data encryption key");
    return null;
  }

  try {
    cached = readDek() ?? generateAndStoreDek();
  } catch (err) {
    console.warn("[electron] Failed to create a data encryption key:", err);
    return null;
  }
  return cached;
}

/** The stored key, or null when there is none or it can't be decrypted. */
function readDek(): string | null {
  if (!fs.existsSync(DEK_FILE)) return null;
  try {
    const dekBase64 = safeStorage.decryptString(fs.readFileSync(DEK_FILE));
    const decoded = Buffer.from(dekBase64, "base64");
    if (decoded.length !== 32) throw new Error(`Invalid DEK length: ${decoded.length}`);
    return dekBase64;
  } catch (err) {
    console.warn("[electron] Failed to decrypt DEK file, generating new key:", err);
    return null;
  }
}

function generateAndStoreDek(): string {
  const dek = crypto.randomBytes(32);
  const dekBase64 = dek.toString("base64");
  const encrypted = safeStorage.encryptString(dekBase64);
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(DEK_FILE, encrypted, { mode: 0o600 });
  console.log("[electron] Generated and stored new data encryption key");
  return dekBase64;
}
