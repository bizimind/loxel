import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  LAYOUT_SESSION_PREFIX,
  layoutCanonicalKeyFromSuffix,
  layoutSessionSuffix,
  layoutSessionWindowId,
} from "@/lib/layout-key-schema";

import { config } from "./config";

const DB_PATH = join(config.stateDir, "stores.db");

let db: Database | null = null;

const changeListeners = new Set<(key: string) => void>();

/** Subscribe to store writes and deletes by key. Returns an unsubscribe function. */
export function onStoreChange(listener: (key: string) => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

function notifyStoreChange(key: string): void {
  for (const listener of changeListeners) listener(key);
}

function getDb(): Database {
  if (db) return db;

  if (!existsSync(config.stateDir)) {
    mkdirSync(config.stateDir, { recursive: true });
  }

  db = new Database(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(`CREATE TABLE IF NOT EXISTS stores (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  return db;
}

/** Read a store's persisted JSON string by key. Returns null if not found. */
export function getStore(key: string): string | null {
  const row = getDb().prepare("SELECT value FROM stores WHERE key = ?").get(key) as {
    value: string;
  } | null;
  return row?.value ?? null;
}

/** Upsert a store's JSON string by key. */
export function putStore(key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO stores (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, value, new Date().toISOString());
  notifyStoreChange(key);
}

/** Delete a store by key (no-op when missing). */
export function deleteStore(key: string): void {
  getDb().prepare("DELETE FROM stores WHERE key = ?").run(key);
  notifyStoreChange(key);
}

/** Every stored key. */
export function listStoreKeys(): string[] {
  const rows = getDb().prepare("SELECT key FROM stores").all() as Array<{ key: string }>;
  return rows.map((row) => row.key);
}

/**
 * Promote the `layout:session:<windowId>:*` rows of each window in `windowIds` to
 * `layout:canonical:*` and delete them, atomically. Called when windows close (orderly): their
 * session-scoped layouts become the canonical "last closed window" layout that the next solo window
 * will restore. The windows apply in order, so where several have a row for one worktree the last
 * one wins: a quit closing every window passes them least recently focused first.
 */
export function promoteLayoutSessions(windowIds: readonly string[]): void {
  const db = getDb();
  const select = db.prepare("SELECT key, value FROM stores WHERE key LIKE ? || '%'");
  const promote = db.transaction(() => {
    const now = new Date().toISOString();
    const upsert = db.prepare(
      `INSERT INTO stores (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    );
    const del = db.prepare("DELETE FROM stores WHERE key = ?");
    for (const windowId of windowIds) {
      const sessionPrefix = `${LAYOUT_SESSION_PREFIX}${windowId}:`;
      const rows = select.all(sessionPrefix) as { key: string; value: string }[];
      for (const row of rows) {
        const suffix = row.key.slice(sessionPrefix.length); // "<scope>:<worktreePath>"
        upsert.run(layoutCanonicalKeyFromSuffix(suffix), row.value, now);
        del.run(row.key);
      }
    }
  });
  promote();
}

/**
 * An `updated_at` as milliseconds, so rows compare as times rather than strings. One that does not
 * parse (never written today) counts as oldest instead of comparing false both ways.
 */
function timeOf(updatedAt: string): number {
  const time = Date.parse(updatedAt);
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}

/**
 * Recover orphan `layout:session:*` rows on server boot. For each
 * (scope, worktreePath) group, promote the most-recently-updated row to canonical,
 * but only when it is newer than the canonical row already there. Then delete the
 * rows of every window not in `liveWindowIds`, in the same transaction.
 *
 * Every path stamps `updated_at` with the time of its write: a session write when
 * the renderer saves, promotion when the window closes, recovery at boot. So a
 * canonical row is never older than the session row it came from, and a session
 * row newer than its canonical was written after the last promote or recovery of
 * that key: by a window that never closed cleanly (a crash, or an update install
 * that did not wait for its promote), or by a closing window's last write landing
 * after its own promote. Either way it holds the latest layout. An older row lost
 * to a later close or recovery, and promoting it would replace the layout that
 * close saved with a stale one.
 *
 * Only Electron main knows which windows are alive, so `liveWindowIds` comes from
 * it: every window it has not seen close, a reloading one included. That is none
 * at launch, and the surviving windows after a server crash, whose health-check
 * reload re-creates the same renderers (with their original windowIds, baked into
 * additionalArguments at BrowserWindow creation). Their rows must stay: a non-first
 * window that found none would drop to the default layout, since its pre-baked
 * `IS_FIRST_WINDOW=false` blocks the canonical fallback. Age cannot tell them
 * apart, since a surviving window's row can be older than its canonical when
 * another window closed after its last write. Any other window's rows are dead
 * once recovery has run: their window is gone, and recovery has already promoted
 * them where they held the latest layout. A server main did not start has no one
 * to say which windows live (`null`) and deletes nothing.
 */
export function recoverOrphanLayoutSessions(liveWindowIds: readonly string[] | null): void {
  const db = getDb();
  const rows = db
    .prepare("SELECT key, value, updated_at FROM stores WHERE key LIKE ? || '%'")
    .all(LAYOUT_SESSION_PREFIX) as { key: string; value: string; updated_at: string }[];
  if (rows.length === 0) return;

  // Group by suffix `<scope>:<worktreePath>`, keep the most recent per group.
  const winners = new Map<string, { value: string; updatedAt: number }>();
  for (const row of rows) {
    const suffix = layoutSessionSuffix(row.key);
    if (suffix === null) continue;
    const updatedAt = timeOf(row.updated_at);
    const current = winners.get(suffix);
    if (!current || updatedAt > current.updatedAt) {
      winners.set(suffix, { value: row.value, updatedAt });
    }
  }

  const live = liveWindowIds === null ? null : new Set(liveWindowIds);
  const recover = db.transaction(() => {
    const now = new Date().toISOString();
    const canonicalUpdatedAt = db.prepare("SELECT updated_at FROM stores WHERE key = ?");
    const upsert = db.prepare(
      `INSERT INTO stores (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    );
    for (const [suffix, winner] of winners) {
      const canonicalKey = layoutCanonicalKeyFromSuffix(suffix);
      const canonical = canonicalUpdatedAt.get(canonicalKey) as { updated_at: string } | null;
      if (canonical && winner.updatedAt <= timeOf(canonical.updated_at)) continue;
      upsert.run(canonicalKey, winner.value, now);
    }
    if (live === null) return;
    const del = db.prepare("DELETE FROM stores WHERE key = ?");
    for (const row of rows) {
      const windowId = layoutSessionWindowId(row.key);
      if (windowId !== null && !live.has(windowId)) del.run(row.key);
    }
  });
  recover();
}
