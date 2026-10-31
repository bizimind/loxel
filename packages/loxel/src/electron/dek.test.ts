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
  isEncryptionAvailable: () => safeStorage.available,
  encryptString: (value: string) => {
    if (safeStorage.encryptFails) throw new Error("Keychain refused");
    return Buffer.from(value, "utf8");
  },
  decryptString: (value: Buffer) => value.toString("utf8"),
};
const exit = mock(() => {});
const showErrorBox = mock(() => {});

void mock.module("electron", () => ({ app: { exit }, dialog: { showErrorBox }, safeStorage }));

/** A fresh module each time: it caches the key for the process. */
let load = 0;
async function loadOrCreateDek(): Promise<string | null> {
  const dek = (await import(`./dek?${load++}`)) as typeof import("./dek");
  return dek.loadOrCreateDek();
}

afterAll(() => fs.rmSync(stateDir, { recursive: true, force: true }));

beforeEach(() => {
  safeStorage.available = true;
  safeStorage.encryptFails = false;
  fs.rmSync(dekFile, { force: true });
});

describe("loadOrCreateDek", () => {
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
});
