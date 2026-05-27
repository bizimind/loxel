import { app, dialog, safeStorage } from "electron";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { IS_DEV } from "./env";

const STATE_DIR = IS_DEV
  ? path.join(os.homedir(), ".local", "state", "loxel", "loxel-dev")
  : path.join(os.homedir(), ".local", "state", "loxel", "loxel");
const DEK_FILE = path.join(STATE_DIR, "data-encryption-key.enc");

let cached: string | null = null;

export function loadOrCreateDek(): string {
  if (cached) return cached;

  if (!safeStorage.isEncryptionAvailable()) {
    dialog.showErrorBox(
      "Encryption Unavailable",
      "System keychain encryption is not available. Loxel cannot start without secure key storage.",
    );
    app.exit(1);
    throw new Error("safeStorage not available");
  }

  let dekBase64: string;
  if (fs.existsSync(DEK_FILE)) {
    try {
      const encrypted = fs.readFileSync(DEK_FILE);
      dekBase64 = safeStorage.decryptString(encrypted);
      const decoded = Buffer.from(dekBase64, "base64");
      if (decoded.length !== 32) throw new Error(`Invalid DEK length: ${decoded.length}`);
    } catch (err) {
      console.warn("[electron] Failed to decrypt DEK file, generating new key:", err);
      dekBase64 = generateAndStoreDek();
    }
  } else {
    dekBase64 = generateAndStoreDek();
  }

  cached = dekBase64;
  return dekBase64;
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
