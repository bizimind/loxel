import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  LAYOUT_SESSION_PREFIX,
  layoutCanonicalKeyFromSuffix,
  layoutSessionSuffix,
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
 * Promote all `layout:session:<windowId>:*` rows to `layout:canonical:*`, atomically.
 * Called when a window closes (orderly) — its session-scoped layout becomes the
 * canonical "last closed window" layout that the next solo window will restore.
 */
export function promoteLayoutSession(windowId: string): void {
  const sessionPrefix = `${LAYOUT_SESSION_PREFIX}${windowId}:`;
  const db = getDb();
  const rows = db
    .prepare("SELECT key, value FROM stores WHERE key LIKE ? || '%'")
    .all(sessionPrefix) as { key: string; value: string }[];
  if (rows.length === 0) return;

  const promote = db.transaction(() => {
    const now = new Date().toISOString();
    const upsert = db.prepare(
      `INSERT INTO stores (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    );
    const del = db.prepare("DELETE FROM stores WHERE key = ?");
    for (const row of rows) {
      const suffix = row.key.slice(sessionPrefix.length); // "<scope>:<worktreePath>"
      upsert.run(layoutCanonicalKeyFromSuffix(suffix), row.value, now);
      del.run(row.key);
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
 * but only when it is newer than the canonical row already there.
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
 * We deliberately do NOT delete session rows here, not even ones older than their
 * canonical. After a server crash, the health-check reload re-creates the same
 * renderers (with their original windowIds, baked into additionalArguments at
 * BrowserWindow creation). Wiping sessions would strand non-first windows: they'd
 * find no session row, their pre-baked `IS_FIRST_WINDOW=false` blocks the
 * canonical fallback, and they'd drop to the default layout, losing the user's
 * customization. A surviving window's row can be older than its canonical when
 * another window closed after its last write, so age alone does not mark a row
 * as dead. Leaving session rows in place lets every surviving renderer restore
 * its pre-crash state. Rows of windows that did not survive stay until their
 * worktree is removed.
 */
export function recoverOrphanLayoutSessions(): void {
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

  const promote = db.transaction(() => {
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
  });
  promote();
}
