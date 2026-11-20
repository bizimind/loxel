import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { layoutCanonicalKey, layoutSessionKey } from "@/lib/layout-key-schema";

import { config } from "./config";
import {
  getStore,
  listStoreKeys,
  promoteLayoutSessions,
  putStore,
  recoverOrphanLayoutSessions,
} from "./store-db";

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
const WINDOW_C = "8570707d-0000-4000-8000-000000000003";
const WINDOW_D = "8570707d-0000-4000-8000-000000000004";

describe("promoteLayoutSessions", () => {
  test("applies the windows in order, so the last one wins a worktree both have", () => {
    putStore(layoutSessionKey(WINDOW_C, "center", "/repo/quit"), "used-first");
    putStore(layoutSessionKey(WINDOW_C, "center", "/repo/only-c"), "only-c");
    putStore(layoutSessionKey(WINDOW_D, "center", "/repo/quit"), "used-last");

    promoteLayoutSessions([WINDOW_C, WINDOW_D]);

    expect(getStore(layoutCanonicalKey("center", "/repo/quit"))).toBe("used-last");
    expect(getStore(layoutCanonicalKey("center", "/repo/only-c"))).toBe("only-c");
    expect(getStore(layoutSessionKey(WINDOW_C, "center", "/repo/quit"))).toBeNull();
    expect(getStore(layoutSessionKey(WINDOW_C, "center", "/repo/only-c"))).toBeNull();
    expect(getStore(layoutSessionKey(WINDOW_D, "center", "/repo/quit"))).toBeNull();
  });
});

describe("recoverOrphanLayoutSessions", () => {
  test("leaves a canonical row newer than every orphan alone", () => {
    const canonical = layoutCanonicalKey("center", "/repo/stale");
    putAt(layoutSessionKey(WINDOW_A, "center", "/repo/stale"), "old", "2026-10-02T09:00:00.000Z");
    putAt(canonical, "last-closed", "2026-11-19T23:42:10.000Z");

    recoverOrphanLayoutSessions(null);

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

    recoverOrphanLayoutSessions(null);

    expect(getStore(canonical)).toBe("after-close");
  });

  test("promotes the newest of several orphans for one key", () => {
    const canonical = layoutCanonicalKey("outer", "/repo/two");
    putAt(canonical, "last-closed", "2026-11-01T00:00:00.000Z");
    putAt(layoutSessionKey(WINDOW_A, "outer", "/repo/two"), "older", "2026-11-02T00:00:00.000Z");
    putAt(layoutSessionKey(WINDOW_B, "outer", "/repo/two"), "newer", "2026-11-03T00:00:00.000Z");

    recoverOrphanLayoutSessions(null);

    expect(getStore(canonical)).toBe("newer");
  });

  test("promotes an orphan when no canonical row exists", () => {
    const canonical = layoutCanonicalKey("center", "/repo/fresh");
    putAt(layoutSessionKey(WINDOW_A, "center", "/repo/fresh"), "only", "2026-04-01T00:00:00.000Z");

    recoverOrphanLayoutSessions(null);

    expect(getStore(canonical)).toBe("only");
  });

  test("keeps the layout a closing window promoted over an older orphan", () => {
    // The restart that lost a tab: window B closes and promotes, then the next server boots with
    // window A's row from a window that never closed cleanly.
    const canonical = layoutCanonicalKey("center", "/repo/restart");
    putAt(layoutSessionKey(WINDOW_A, "center", "/repo/restart"), "old", "2000-01-01T00:00:00.000Z");
    putStore(layoutSessionKey(WINDOW_B, "center", "/repo/restart"), "with-browser-tab");
    promoteLayoutSessions([WINDOW_B]);

    recoverOrphanLayoutSessions(null);

    expect(getStore(canonical)).toBe("with-browser-tab");
  });

  test("with the app's open windows, keeps theirs and deletes every other window's rows", () => {
    // Fresh IDs: deleting dead windows' rows reaches every row of the table.
    const live = crypto.randomUUID();
    const deadNewer = crypto.randomUUID();
    const deadOlder = crypto.randomUUID();
    const canonical = layoutCanonicalKey("center", "/repo/prune");
    const otherCanonical = layoutCanonicalKey("center", "/repo/prune-other");
    putAt(canonical, "last-closed", "2026-11-10T00:00:00.000Z");
    putAt(otherCanonical, "other-closed", "2026-11-10T00:00:00.000Z");
    // A surviving window's row older than its canonical: another window closed after its write.
    putAt(layoutSessionKey(live, "center", "/repo/prune"), "live", "2026-11-01T00:00:00.000Z");
    putAt(
      layoutSessionKey(deadNewer, "center", "/repo/prune-other"),
      "crashed-after-close",
      "2026-11-11T00:00:00.000Z",
    );
    putAt(
      layoutSessionKey(deadOlder, "center", "/repo/prune"),
      "stale",
      "2026-10-01T00:00:00.000Z",
    );

    recoverOrphanLayoutSessions([live]);

    expect(getStore(layoutSessionKey(live, "center", "/repo/prune"))).toBe("live");
    expect(getStore(canonical)).toBe("last-closed");
    // Promoted before its rows went: it held the latest layout.
    expect(getStore(otherCanonical)).toBe("crashed-after-close");
    expect(getStore(layoutSessionKey(deadNewer, "center", "/repo/prune-other"))).toBeNull();
    expect(getStore(layoutSessionKey(deadOlder, "center", "/repo/prune"))).toBeNull();
  });

  test("at launch, with no window open, deletes every session row", () => {
    const window = crypto.randomUUID();
    putAt(layoutSessionKey(window, "outer", "/repo/launch"), "left", "2026-11-01T00:00:00.000Z");

    recoverOrphanLayoutSessions([]);

    expect(getStore(layoutCanonicalKey("outer", "/repo/launch"))).toBe("left");
    expect(listStoreKeys().filter((key) => key.startsWith("layout:session:"))).toEqual([]);
  });
});
