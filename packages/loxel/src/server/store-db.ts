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
 * Recover orphan `layout:session:*` rows on server boot. For each
 * (scope, worktreePath) group, promote the most-recently-updated row to canonical.
 *
 * We deliberately do NOT delete session rows here. After a server crash, the
 * health-check reload re-creates the same renderers (with their original
 * windowIds, baked into additionalArguments at BrowserWindow creation). Wiping
 * sessions would strand non-first windows: they'd find no session row, their
 * pre-baked `IS_FIRST_WINDOW=false` blocks the canonical fallback, and they'd
 * drop to the default layout, losing the user's customization. Leaving session
 * rows in place lets every surviving renderer restore its pre-crash state.
 *
 * Stale rows (from windows whose renderer didn't survive) accumulate slowly but
 * are bounded by (windows × worktrees); promote-on-close cleans them naturally
 * when the user next closes those windows.
 */
export function recoverOrphanLayoutSessions(): void {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT key, value, updated_at FROM stores WHERE key LIKE ? || '%' ORDER BY updated_at DESC",
    )
    .all(LAYOUT_SESSION_PREFIX) as { key: string; value: string; updated_at: string }[];
  if (rows.length === 0) return;

  // Group by suffix `<scope>:<worktreePath>`, keep first (most recent) per group.
  const winners = new Map<string, string>();
  for (const row of rows) {
    const suffix = layoutSessionSuffix(row.key);
    if (suffix === null) continue;
    if (!winners.has(suffix)) winners.set(suffix, row.value);
  }

  const promote = db.transaction(() => {
    const now = new Date().toISOString();
    const upsert = db.prepare(
      `INSERT INTO stores (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    );
    for (const [suffix, value] of winners) {
      upsert.run(layoutCanonicalKeyFromSuffix(suffix), value, now);
    }
  });
  promote();
}
