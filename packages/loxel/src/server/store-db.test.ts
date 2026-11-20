import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { layoutCanonicalKey, layoutSessionKey } from "@/lib/layout-key-schema";

import { config } from "./config";
import { getStore, promoteLayoutSession, putStore, recoverOrphanLayoutSessions } from "./store-db";

// A second connection to the same file, to set `updated_at` explicitly: the store API stamps it
// with the current time.
const rawDb = new Database(join(config.stateDir, "stores.db"));
afterAll(() => rawDb.close());

function putAt(key: string, value: string, updatedAt: string): void {
  putStore(key, value);
  rawDb.prepare("UPDATE stores SET updated_at = ? WHERE key = ?").run(updatedAt, key);
}

function updatedAtOf(key: string): string | null {
  const row = rawDb.prepare("SELECT updated_at FROM stores WHERE key = ?").get(key) as {
    updated_at: string;
  } | null;
  return row?.updated_at ?? null;
}

const WINDOW_A = "8570707d-0000-4000-8000-000000000001";
const WINDOW_B = "8570707d-0000-4000-8000-000000000002";

describe("recoverOrphanLayoutSessions", () => {
  test("leaves a canonical row newer than every orphan alone", () => {
    const canonical = layoutCanonicalKey("center", "/repo/stale");
    putAt(layoutSessionKey(WINDOW_A, "center", "/repo/stale"), "old", "2026-10-02T09:00:00.000Z");
    putAt(canonical, "last-closed", "2026-11-19T23:42:10.000Z");

    recoverOrphanLayoutSessions();

    expect(getStore(canonical)).toBe("last-closed");
    expect(updatedAtOf(canonical)).toBe("2026-11-19T23:42:10.000Z");
    // Session rows stay for renderers that survive a server crash.
    expect(getStore(layoutSessionKey(WINDOW_A, "center", "/repo/stale"))).toBe("old");
  });

  test("promotes an orphan written after the canonical row", () => {
    const canonical = layoutCanonicalKey("center", "/repo/crashed");
    putAt(canonical, "last-closed", "2026-11-19T10:00:00.000Z");
    putAt(
      layoutSessionKey(WINDOW_A, "center", "/repo/crashed"),
      "after-close",
      "2026-11-19T12:00:00.000Z",
    );

    recoverOrphanLayoutSessions();

    expect(getStore(canonical)).toBe("after-close");
  });

  test("promotes the newest of several orphans for one key", () => {
    const canonical = layoutCanonicalKey("outer", "/repo/two");
    putAt(canonical, "last-closed", "2026-11-01T00:00:00.000Z");
    putAt(layoutSessionKey(WINDOW_A, "outer", "/repo/two"), "older", "2026-11-02T00:00:00.000Z");
    putAt(layoutSessionKey(WINDOW_B, "outer", "/repo/two"), "newer", "2026-11-03T00:00:00.000Z");

    recoverOrphanLayoutSessions();

    expect(getStore(canonical)).toBe("newer");
  });

  test("promotes an orphan when no canonical row exists", () => {
    const canonical = layoutCanonicalKey("center", "/repo/fresh");
    putAt(layoutSessionKey(WINDOW_A, "center", "/repo/fresh"), "only", "2026-04-01T00:00:00.000Z");

    recoverOrphanLayoutSessions();

    expect(getStore(canonical)).toBe("only");
  });

  test("keeps the layout a closing window promoted over an older orphan", () => {
    // The restart that lost a tab: window B closes and promotes, then the next server boots with
    // window A's row from a window that never closed cleanly.
    const canonical = layoutCanonicalKey("center", "/repo/restart");
    putAt(layoutSessionKey(WINDOW_A, "center", "/repo/restart"), "old", "2000-01-01T00:00:00.000Z");
    putStore(layoutSessionKey(WINDOW_B, "center", "/repo/restart"), "with-browser-tab");
    promoteLayoutSession(WINDOW_B);

    recoverOrphanLayoutSessions();

    expect(getStore(canonical)).toBe("with-browser-tab");
  });
});
