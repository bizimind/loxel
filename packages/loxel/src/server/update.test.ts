import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.LOXEL_DEV = "1";
const stateDir = await mkdtemp(join(tmpdir(), "loxel-update-"));
process.env.LOXEL_STATE_DIR = stateDir;

const storeDb = await import("./store-db");
const { checkForUpdate, isAutoCheckEnabled, runAutomaticUpdateCheck } = await import("./update");

const persisted = (state: Record<string, unknown>) => JSON.stringify({ state, version: 12 });

const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () =>
  Response.json({ version: "0.0.0", released_at: "", binaries: {} })) as unknown as typeof fetch);

beforeEach(() => {
  fetchSpy.mockClear();
  storeDb.deleteStore("settings");
});

afterAll(async () => {
  fetchSpy.mockRestore();
  await rm(stateDir, { recursive: true, force: true });
});

describe("isAutoCheckEnabled", () => {
  test("is on when there are no settings yet or they predate the setting", () => {
    expect(isAutoCheckEnabled(null)).toBe(true);
    expect(isAutoCheckEnabled(persisted({ terminal: {} }))).toBe(true);
  });

  test("follows the persisted flag", () => {
    expect(isAutoCheckEnabled(persisted({ autoCheckForUpdates: true }))).toBe(true);
    expect(isAutoCheckEnabled(persisted({ autoCheckForUpdates: false }))).toBe(false);
  });

  test("is off when the row cannot be parsed, since it may hold an opt-out", () => {
    expect(isAutoCheckEnabled("not json")).toBe(false);
    expect(isAutoCheckEnabled("[]")).toBe(false);
    expect(isAutoCheckEnabled(JSON.stringify({ state: null }))).toBe(false);
  });
});

describe("runAutomaticUpdateCheck", () => {
  test("requests the manifest when no settings are stored", async () => {
    await runAutomaticUpdateCheck(() => {});
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("requests the manifest when the setting is on", async () => {
    storeDb.putStore("settings", persisted({ autoCheckForUpdates: true }));
    await runAutomaticUpdateCheck(() => {});
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("makes no request and broadcasts nothing when the setting is off", async () => {
    storeDb.putStore("settings", persisted({ autoCheckForUpdates: false }));
    const broadcasts: unknown[] = [];
    await runAutomaticUpdateCheck((msg) => broadcasts.push(msg));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(broadcasts).toEqual([]);
  });

  test("reads the setting each time it runs, not once", async () => {
    storeDb.putStore("settings", persisted({ autoCheckForUpdates: true }));
    await runAutomaticUpdateCheck(() => {});
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    storeDb.putStore("settings", persisted({ autoCheckForUpdates: false }));
    await runAutomaticUpdateCheck(() => {});
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("checkForUpdate", () => {
  test("the manual check still requests the manifest when the setting is off", async () => {
    storeDb.putStore("settings", persisted({ autoCheckForUpdates: false }));
    await checkForUpdate(() => {});
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
