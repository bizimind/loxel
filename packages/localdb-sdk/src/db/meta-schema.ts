import type { Database } from "bun:sqlite";

export function initMetaSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _tables (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT UNIQUE NOT NULL,
      label      TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS _columns (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      table_id   INTEGER NOT NULL REFERENCES _tables(id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      position   INTEGER NOT NULL,
      def        TEXT NOT NULL,
      UNIQUE(table_id, name)
    );

    CREATE TABLE IF NOT EXISTS _options (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      column_id  INTEGER NOT NULL REFERENCES _columns(id) ON DELETE CASCADE,
      value      TEXT NOT NULL,
      label      TEXT NOT NULL,
      color      TEXT,
      position   INTEGER NOT NULL DEFAULT 0,
      UNIQUE(column_id, value)
    );

    CREATE TABLE IF NOT EXISTS _views (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      table_id   INTEGER NOT NULL REFERENCES _tables(id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      type       TEXT NOT NULL,
      config     TEXT NOT NULL
    );
  `);
}
