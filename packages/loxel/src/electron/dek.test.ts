import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "electron-dek-"));
process.env.LOXEL_STATE_DIR = stateDir;
const dekFile = path.join(stateDir, "data-encryption-key.enc");

const safeStorage = {
  available: true,
  encryptFails: false,
  keychainLocked: false,
  reEncrypt: false,
  encrypts: 0,
  isAsyncEncryptionAvailable: async () => safeStorage.available,
  encryptStringAsync: async (value: string) => {
    if (safeStorage.encryptFails) throw new Error("Keychain refused");
    safeStorage.encrypts++;
    return Buffer.from(value, "utf8");
  },
  decryptStringAsync: async (value: Buffer) => {
    if (safeStorage.keychainLocked) {
      throw new Error(
        "safeStorage.decryptStringAsync is temporarily unavailable. Please try again.",
      );
    }
    return { result: value.toString("utf8"), shouldReEncrypt: safeStorage.reEncrypt };
  },
};
const exit = mock(() => {});
const showErrorBox = mock(() => {});

void mock.module("electron", () => ({ app: { exit }, dialog: { showErrorBox }, safeStorage }));

/** A fresh module each time: it caches the key for the process. */
let load = 0;
async function freshDek(): Promise<typeof import("./dek")> {
  return (await import(`./dek?${load++}`)) as typeof import("./dek");
}
async function loadOrCreateDek(): Promise<string | null> {
  return (await freshDek()).initDek();
}

afterAll(() => fs.rmSync(stateDir, { recursive: true, force: true }));

beforeEach(() => {
  safeStorage.available = true;
  safeStorage.encryptFails = false;
  safeStorage.keychainLocked = false;
  safeStorage.reEncrypt = false;
  safeStorage.encrypts = 0;
  fs.rmSync(dekFile, { force: true });
});

describe("initDek", () => {
  test("creates a key, then reads the same key back", async () => {
    const created = await loadOrCreateDek();
    expect(Buffer.from(created ?? "", "base64")).toHaveLength(32);
    expect(await loadOrCreateDek()).toBe(created);
  });

  test("returns null without the keychain, with no dialog and no exit", async () => {
    safeStorage.available = false;
    expect(await loadOrCreateDek()).toBeNull();
    expect(fs.existsSync(dekFile)).toBe(false);
    expect(showErrorBox).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  test("returns null when the key can't be stored", async () => {
    safeStorage.encryptFails = true;
    expect(await loadOrCreateDek()).toBeNull();
  });

  test("replaces a stored key it can't use", async () => {
    fs.writeFileSync(dekFile, "c2hvcnQ=");
    const replaced = await loadOrCreateDek();
    expect(Buffer.from(replaced ?? "", "base64")).toHaveLength(32);
  });

  test("keeps the stored key when the keychain withholds it", async () => {
    const created = await loadOrCreateDek();
    safeStorage.keychainLocked = true;
    expect(await loadOrCreateDek()).toBeNull();
    expect(fs.readFileSync(dekFile, "utf8")).toBe(created ?? "");
  });

  test("stores the key again when the keychain key rotated", async () => {
    const created = await loadOrCreateDek();
    expect(await loadOrCreateDek()).toBe(created);
    expect(safeStorage.encrypts).toBe(1);
    safeStorage.reEncrypt = true;
    expect(await loadOrCreateDek()).toBe(created);
    expect(safeStorage.encrypts).toBe(2);
  });
});

describe("getDek", () => {
  test("returns what initDek loaded", async () => {
    const dek = await freshDek();
    expect(() => dek.getDek()).toThrow();
    const created = await dek.initDek();
    expect(dek.getDek()).toBe(created);
  });
});
