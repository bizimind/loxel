import type { Database } from "bun:sqlite";

import type { ColumnDef } from "../column-types/column-def.ts";

import {
  buildColumnDdlFragment,
  columnToDdl,
  quoteName,
  isFormula,
  hasInlineOptions,
} from "../column-types/ddl.ts";
import { OptionsManager } from "../options/manager.ts";
import { parseColumnDef, parseColumnDefs } from "../validation/schemas.ts";

export interface TableMeta {
  id: number;
  name: string;
  label: string;
  createdAt: string;
}

export interface ColumnMeta {
  id: number;
  tableId: number;
  name: string;
  position: number;
  def: ColumnDef;
}

export interface TableSchema {
  table: TableMeta;
  columns: ColumnMeta[];
}

interface TableRow {
  id: number;
  name: string;
  label: string;
  created_at: string;
}

interface ColumnRow {
  id: number;
  table_id: number;
  name: string;
  position: number;
  def: string;
}

export class SchemaManager {
  constructor(private readonly db: Database) {}

  createTable(name: string, label: string, columns: ColumnDef[]): TableMeta {
    validateTableName(name);
    const parsedColumns = parseColumnDefs(columns);
    const columnNames = parsedColumns.map((col) => colName(col.label));
    validateUniqueColumnNames(columnNames);
    validateColumnReferences(this.db, parsedColumns);

    return this.db.transaction(() => {
      const now = new Date().toISOString();
      const result = this.db
        .prepare("INSERT INTO _tables (name, label, created_at) VALUES (?, ?, ?)")
        .run(name, label, now);
      const tableId = Number(result.lastInsertRowid);

      const optionsMgr = new OptionsManager(this.db);
      const insertCol = this.db.prepare(
        "INSERT INTO _columns (table_id, name, position, def) VALUES (?, ?, ?, ?)",
      );

      const storedCols = parsedColumns.filter((c) => !isFormula(c)) as Exclude<
        ColumnDef,
        { kind: "formula" }
      >[];

      const columnIds: number[] = [];
      for (let position = 0; position < parsedColumns.length; position++) {
        const col = parsedColumns[position]!;
        const res = insertCol.run(tableId, columnNames[position]!, position, JSON.stringify(col));
        columnIds.push(Number(res.lastInsertRowid));
      }

      for (let i = 0; i < parsedColumns.length; i++) {
        const col = parsedColumns[i]!;
        const colId = columnIds[i]!;
        if (hasInlineOptions(col)) {
          const updatedItems = optionsMgr.syncOptions(colId, col.options.items);
          const updatedDef = { ...col, options: { ...col.options, items: updatedItems } };
          this.db
            .prepare("UPDATE _columns SET def = ? WHERE id = ?")
            .run(JSON.stringify(updatedDef), colId);
        }
      }

      const storedColumnNames = storedCols.map((col) => colName(col.label));
      const colFragments = storedCols.map((col, index) =>
        buildColumnDdlFragment(storedColumnNames[index]!, col),
      );

      const colsSql = colFragments.length > 0 ? `,\n  ${colFragments.join(",\n  ")}` : "";
      const ddl = `CREATE TABLE ${dataTableName(name)} (\n  id INTEGER PRIMARY KEY AUTOINCREMENT${colsSql}\n)`;
      this.db.exec(ddl);

      for (const col of storedCols) {
        createIndexIfNeeded(this.db, name, col);
      }

      return { id: tableId, name, label, createdAt: now };
    })();
  }

  dropTable(name: string): void {
    const table = this.getTableByName(name);
    this.db.transaction(() => {
      this.db.exec(`DROP TABLE IF EXISTS ${dataTableName(name)}`);
      this.db.prepare("DELETE FROM _tables WHERE id = ?").run(table.id);
    })();
  }

  renameTable(name: string, newName: string): void {
    validateTableName(newName);
    const table = this.getTableByName(name);
    this.db.transaction(() => {
      this.db.exec(`ALTER TABLE ${dataTableName(name)} RENAME TO ${dataTableName(newName)}`);
      this.db.prepare("UPDATE _tables SET name = ? WHERE id = ?").run(newName, table.id);
    })();
  }

  listTables(): TableMeta[] {
    const rows = this.db.prepare("SELECT * FROM _tables ORDER BY id").all() as TableRow[];
    return rows.map(rowToMeta);
  }

  getTableSchema(name: string): TableSchema {
    const table = this.getTableByName(name);
    const colRows = this.db
      .prepare("SELECT * FROM _columns WHERE table_id = ? ORDER BY position")
      .all(table.id) as ColumnRow[];
    const columns = colRows.map(rowToColumnMeta);
    return { table, columns };
  }

  getTableByName(name: string): TableMeta {
    const row = this.db
      .prepare("SELECT * FROM _tables WHERE name = ?")
      .get(name) as TableRow | null;
    if (!row) throw new Error(`Table not found: ${name}`);
    return rowToMeta(row);
  }
}

function rowToMeta(row: TableRow): TableMeta {
  return { id: row.id, name: row.name, label: row.label, createdAt: row.created_at };
}

function rowToColumnMeta(row: ColumnRow): ColumnMeta {
  return {
    id: row.id,
    tableId: row.table_id,
    name: row.name,
    position: row.position,
    def: parseColumnDef(JSON.parse(row.def)),
  };
}

export function dataTableName(tableName: string): string {
  return `"data_${tableName.replace(/"/g, '""')}"`;
}

export function colName(label: string): string {
  const name = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
  validateColumnName(name);
  return name;
}

export function validateTableName(name: string): void {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) {
    throw new Error(
      `Invalid table name "${name}": must start with a letter and contain only a-z, 0-9, _`,
    );
  }
}

export function validateColumnName(name: string): void {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) {
    throw new Error(
      `Invalid column name "${name}": must start with a letter and contain only a-z, 0-9, _`,
    );
  }
}

export function validateUniqueColumnNames(names: string[]): void {
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) throw new Error(`Duplicate column name: ${name}`);
    seen.add(name);
  }
}

export function validateColumnReferences(db: Database, columns: ColumnDef[]): void {
  for (const def of columns) {
    if (def.kind === "ref") {
      validateTableName(def.targetTable);
      validateColumnName(def.targetColumn);
      const table = db.prepare("SELECT id FROM _tables WHERE name = ?").get(def.targetTable) as {
        id: number;
      } | null;
      if (!table) throw new Error(`Referenced table not found: ${def.targetTable}`);
      const column =
        def.targetColumn === "id"
          ? { name: "id" }
          : (db
              .prepare("SELECT name FROM _columns WHERE table_id = ? AND name = ?")
              .get(table.id, def.targetColumn) as { name: string } | null);
      if (!column) {
        throw new Error(`Referenced column not found: ${def.targetTable}.${def.targetColumn}`);
      }
    }

    if ("options" in def && def.options?.source === "ref") {
      validateTableName(def.options.table);
      validateColumnName(def.options.valueColumn);
      validateColumnName(def.options.labelColumn);
      const table = db.prepare("SELECT id FROM _tables WHERE name = ?").get(def.options.table) as {
        id: number;
      } | null;
      if (!table) throw new Error(`Referenced option table not found: ${def.options.table}`);
      for (const columnName of [def.options.valueColumn, def.options.labelColumn]) {
        const column =
          columnName === "id"
            ? { name: "id" }
            : (db
                .prepare("SELECT name FROM _columns WHERE table_id = ? AND name = ?")
                .get(table.id, columnName) as { name: string } | null);
        if (!column) {
          throw new Error(`Referenced option column not found: ${def.options.table}.${columnName}`);
        }
      }
    }
  }
}

export function createIndexIfNeeded(
  db: Database,
  tableName: string,
  col: Exclude<ColumnDef, { kind: "formula" }>,
): void {
  createIndexForColumn(db, tableName, colName(col.label), col);
}

export function createIndexForColumn(
  db: Database,
  tableName: string,
  name: string,
  col: Exclude<ColumnDef, { kind: "formula" }>,
): void {
  if (col.kind === "longtext") return;
  const { shouldIndex } = columnToDdl(name, col);
  if (!shouldIndex) return;
  db.exec(
    `CREATE INDEX IF NOT EXISTS "idx_${tableName}_${name}" ON ${dataTableName(tableName)} (${quoteName(name)})`,
  );
}
