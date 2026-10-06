import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.LOXEL_DEV = "1";
const stateDir = await mkdtemp(join(tmpdir(), "loxel-store-enc-"));
process.env.LOXEL_STATE_DIR = stateDir;

const { initSecretStore, isEncrypted } = await import("./secret-store");
const { decryptModelKeys, encryptModelKeys, hasPlaintextModelKeys, isEncryptedStoreKey } =
  await import("./store-encryption");
const storeDb = await import("./store-db");
const { handleRequest } = await import("./routes");
type RouteContext = import("./routes").RouteContext;

const settings = (apiKey: string) =>
  JSON.stringify({ state: { models: [{ id: "m", apiKey }], other: 1 }, version: 10 });

beforeAll(async () => {
  await initSecretStore();
});

afterAll(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

describe("isEncryptedStoreKey", () => {
  test("matches the settings store and the -settings suffix only", () => {
    expect(isEncryptedStoreKey("settings")).toBe(true);
    expect(isEncryptedStoreKey("agent-settings")).toBe(true);
    for (const key of ["keybindings", "ui", "tools-bar", "projects", "layout:canonical:x"]) {
      expect(isEncryptedStoreKey(key)).toBe(false);
    }
  });
});

describe("model key transforms", () => {
  test("encrypts plaintext keys, leaves encrypted ones, and round-trips", () => {
    const plain = settings("sk-plain");
    expect(hasPlaintextModelKeys(plain)).toBe(true);
    const enc = encryptModelKeys(plain);
    const parsed = JSON.parse(enc);
    expect(isEncrypted(parsed.state.models[0].apiKey)).toBe(true);
    expect(hasPlaintextModelKeys(enc)).toBe(false);
    expect(encryptModelKeys(enc)).toBe(enc);
    expect(JSON.parse(decryptModelKeys(enc)).state.models[0].apiKey).toBe("sk-plain");
  });

  test("ignores states without models and empty keys", () => {
    const noModels = JSON.stringify({ state: { theme: "dark" } });
    expect(hasPlaintextModelKeys(noModels)).toBe(false);
    expect(encryptModelKeys(noModels)).toBe(noModels);
    const empty = settings("");
    expect(hasPlaintextModelKeys(empty)).toBe(false);
  });
});

describe("GET /api/stores/settings", () => {
  const ctx = {
    broadcastToSubscribers: () => {},
    broadcastToProject: () => {},
    broadcastAll: () => {},
    sendToActiveWindow: () => false,
    externalFolderConflict: () => null,
    getProject: () => undefined,
    findProjectForPath: () => undefined,
    getWorktreeResources: () => undefined,
    suspendWorktreeWatchers: async () => async () => {},
    completeWorktreeRemoval: () => {},
    resolveFilePath: () => null,
    initializeProject: async () => ({ project: {} as never, worktrees: [] }),
    teardownProject: () => {},
    shutdown: () => {},
    resolveSchema: async () => ({}),
    updateYamlSchemas: () => {},
    formatContent: async () => null,
    getDetectedFormatters: () => [],
  } as RouteContext;

  test("migrates a plaintext row to encrypted at rest and returns plaintext", async () => {
    storeDb.putStore("settings", settings("sk-legacy"));
    const res = await handleRequest(new Request("http://x/api/stores/settings"), ctx);
    const body = (await res.json()) as { value: string };
    expect(JSON.parse(body.value).state.models[0].apiKey).toBe("sk-legacy");
    const stored = storeDb.getStore("settings");
    expect(stored).not.toBeNull();
    expect(hasPlaintextModelKeys(stored!)).toBe(false);
    expect(isEncrypted(JSON.parse(stored!).state.models[0].apiKey)).toBe(true);
  });

  test("PUT encrypts before storing", async () => {
    const res = await handleRequest(
      new Request("http://x/api/stores/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: settings("sk-new") }),
      }),
      ctx,
    );
    expect(res.status).toBe(200);
    const stored = storeDb.getStore("settings");
    expect(hasPlaintextModelKeys(stored!)).toBe(false);
  });
});
