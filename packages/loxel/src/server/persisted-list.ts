/**
 * A list the server keeps in memory and writes through to its own SQLite file, so it survives a
 * restart: the notifications and the open inbox. The caller owns the list and its limits; this only
 * mirrors its inserts and deletes, in insertion order.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { z } from "zod";

import { logger } from "./logger";

const log = logger.child("server");

/** A persisted item: its `id` is the row's key. */
interface Identified {
  id: string;
}

export class PersistedList<T extends Identified> {
  private db: Database | null = null;
  /** Logged once, then the list goes on in memory only, as before persistence. */
  private failed = false;

  /** `path` null keeps nothing (tests, and a list nothing needs to survive). */
  constructor(
    private readonly path: string | null,
    private readonly schema: z.ZodType<T>,
  ) {}

  /** The items persisted, oldest first. Rows that no longer parse are dropped and deleted. */
  load(): T[] {
    const items: T[] = [];
    const invalid: string[] = [];
    this.run("read", (db) => {
      const rows = db.prepare("SELECT id, data FROM items ORDER BY seq").all() as Array<{
        id: string;
        data: string;
      }>;
      for (const row of rows) {
        const parsed = this.schema.safeParse(safeJson(row.data));
        if (parsed.success) items.push(parsed.data);
        else invalid.push(row.id);
      }
    });
    if (invalid.length > 0) {
      log.warn(`Dropped ${invalid.length} unreadable row(s) of ${this.path}`);
      this.delete(invalid);
    }
    return items;
  }

  insert(item: T): void {
    this.run("write", (db) => {
      db.prepare("INSERT OR REPLACE INTO items (id, data) VALUES (?, ?)").run(
        item.id,
        JSON.stringify(item),
      );
    });
  }

  delete(ids: readonly string[]): void {
    if (ids.length === 0) return;
    this.run("write", (db) => {
      const remove = db.prepare("DELETE FROM items WHERE id = ?");
      db.transaction(() => {
        for (const id of ids) remove.run(id);
      })();
    });
  }

  clear(): void {
    this.run("write", (db) => db.exec("DELETE FROM items"));
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  /**
   * Run `action` on the database, opening it first. A failure is logged once and turns persistence
   * off: the list in memory stays right for this server, and only a restart would lose it.
   */
  private run(what: "read" | "write", action: (db: Database) => void): void {
    if (this.path === null || this.failed) return;
    try {
      action(this.open(this.path));
    } catch (err) {
      this.failed = true;
      log.error(`Could not ${what} ${this.path}; it is kept in memory only until a restart`, {
        error: err,
      });
    }
  }

  private open(path: string): Database {
    if (this.db) return this.db;
    mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 5000");
    // `seq` keeps insertion order, which timestamps alone do not within one millisecond.
    db.exec(`CREATE TABLE IF NOT EXISTS items (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT UNIQUE NOT NULL,
      data TEXT NOT NULL
    )`);
    this.db = db;
    return db;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
