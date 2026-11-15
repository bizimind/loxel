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

/** The key `initDek()` loaded: undefined until it has run, null when there is none. */
let loaded: string | null | undefined;

/**
 * Load the data encryption key, creating it on first run, or null when the system keychain can't
 * protect one. Loxel runs without it: the server then reports secret storage as unavailable.
 *
 * Call once after `ready` (the async `safeStorage` methods need it) and before `getDek()`. Uses the
 * async API because Electron removed the synchronous `safeStorage` methods in 46; both read the
 * same keychain item, so keys stored by earlier builds still decrypt.
 */
export async function initDek(): Promise<string | null> {
  if (loaded !== undefined) return loaded;
  loaded = await loadOrCreateDek();
  return loaded;
}

/** The key `initDek()` loaded, to hand the server. */
export function getDek(): string | null {
  if (loaded === undefined) throw new Error("Data encryption key requested before initDek()");
  return loaded;
}

async function loadOrCreateDek(): Promise<string | null> {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) {
    console.warn("[electron] System keychain encryption is unavailable; no data encryption key");
    return null;
  }

  try {
    return (await readDek()) ?? (await generateAndStoreDek());
  } catch (err) {
    console.warn("[electron] No data encryption key:", err);
    return null;
  }
}

/**
 * The stored key, or null when there is none or it can't be used. Throws when the keychain
 * withholds the key that decrypts it (a dismissed or timed-out access prompt): the stored key is
 * fine then, and replacing it would orphan everything encrypted with it.
 */
async function readDek(): Promise<string | null> {
  if (!fs.existsSync(DEK_FILE)) return null;
  try {
    const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(
      fs.readFileSync(DEK_FILE),
    );
    const decoded = Buffer.from(result, "base64");
    if (decoded.length !== 32) throw new Error(`Invalid DEK length: ${decoded.length}`);
    // The keychain key rotated since this was written: store it under the current one.
    if (shouldReEncrypt) await storeDek(result);
    return result;
  } catch (err) {
    if (isKeychainUnavailable(err)) {
      throw new Error("The keychain did not provide the key", { cause: err });
    }
    console.warn("[electron] Failed to decrypt DEK file, generating new key:", err);
    return null;
  }
}

async function storeDek(dekBase64: string): Promise<void> {
  const encrypted = await safeStorage.encryptStringAsync(dekBase64);
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(DEK_FILE, encrypted, { mode: 0o600 });
}

async function generateAndStoreDek(): Promise<string> {
  const dekBase64 = crypto.randomBytes(32).toString("base64");
  await storeDek(dekBase64);
  console.log("[electron] Generated and stored new data encryption key");
  return dekBase64;
}

/**
 * Whether `safeStorage` failed because its keychain key was unavailable, not because the data was
 * bad. Electron reports it only through this message (`electron_api_safe_storage.cc`).
 */
function isKeychainUnavailable(err: unknown): boolean {
  return err instanceof Error && err.message.includes("temporarily unavailable");
}
