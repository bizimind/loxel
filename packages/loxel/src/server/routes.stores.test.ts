import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WsMessage } from "@/api/ws-protocol";

const stateDir = await mkdtemp(join(tmpdir(), "routes-stores-state-"));
process.env.LOXEL_STATE_DIR = stateDir;
const { handleRequest } = await import("./routes");
const storeDb = await import("./store-db");
type RouteContext = import("./routes").RouteContext;

afterAll(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

const LEGACY_STATE = {
  models: [{ id: "1", modelId: "m", provider: "openrouter", apiKey: "enc:v1:secret" }],
  codingAgent: { baseModelId: "1", functionOverrides: {} },
  autoCheckForUpdates: false,
};
const legacyRow = JSON.stringify({ state: LEGACY_STATE, version: 12 });
const cleanRow = JSON.stringify({ state: { autoCheckForUpdates: false }, version: 12 });

function setup() {
  const broadcasts: WsMessage[] = [];
  const ctx = { broadcastAll: (message: WsMessage) => broadcasts.push(message) };
  const request = (key: string, init?: RequestInit) =>
    handleRequest(new Request(`http://x/api/stores/${key}`, init), ctx as unknown as RouteContext);
  const put = (key: string, value: string) =>
    request(key, { method: "PUT", body: JSON.stringify({ value }) });
  const get = async (key: string) => {
    const body = (await (await request(key)).json()) as { value: string | null };
    return body.value;
  };
  return { broadcasts, get, put };
}

describe("/api/stores/settings without the built-in coding agent", () => {
  test("a read strips an old row, and cleans it on disk", async () => {
    const { get } = setup();
    storeDb.putStore("settings", legacyRow);
    expect(await get("settings")).toBe(cleanRow);
    expect(storeDb.getStore("settings")).toBe(cleanRow);
  });

  test("a read leaves a clean row and a missing one alone", async () => {
    const { get } = setup();
    storeDb.putStore("settings", cleanRow);
    expect(await get("settings")).toBe(cleanRow);
    storeDb.deleteStore("settings");
    expect(await get("settings")).toBeNull();
  });

  test("a write from an older window stores and broadcasts no keys", async () => {
    const { broadcasts, put } = setup();
    const plaintext = JSON.stringify({
      state: { ...LEGACY_STATE, models: [{ id: "1", apiKey: "sk-plaintext" }] },
      version: 12,
    });
    expect((await put("settings", plaintext)).ok).toBe(true);
    expect(storeDb.getStore("settings")).toBe(cleanRow);
    expect(JSON.stringify(broadcasts)).not.toContain("sk-plaintext");
    expect(broadcasts).toEqual([
      { type: "store_updated", key: "settings", state: { autoCheckForUpdates: false } },
    ]);
  });

  test("a write that isn't JSON is stored as it came, like any other", async () => {
    const { put } = setup();
    expect((await put("settings", "not json")).ok).toBe(true);
    expect(storeDb.getStore("settings")).toBe("not json");
  });

  test("other stores keep fields of the same names", async () => {
    const { get, put } = setup();
    expect((await put("other-settings", legacyRow)).ok).toBe(true);
    expect(await get("other-settings")).toBe(legacyRow);
  });
});
