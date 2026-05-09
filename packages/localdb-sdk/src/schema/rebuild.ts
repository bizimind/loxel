import type { Database } from "bun:sqlite";

import type { ColumnDef } from "../column-types/column-def.ts";

import { buildColumnDdlFragment, isFormula, quoteName } from "../column-types/ddl.ts";
import { dataTableName } from "./manager.ts";

export interface RebuildColumn {
  name: string;
  def: ColumnDef;
  /** Override for coercion: SQL expression selecting from old table */
  selectExpr?: string;
}

/**
 * Rebuild a data table with a new column set.
 * Handles DROP COLUMN and ALTER COLUMN (type change) cases.
 * Uses CREATE+INSERT+DROP+RENAME pattern (works on all SQLite versions).
 */
export function rebuildTable(db: Database, tableName: string, newColumns: RebuildColumn[]): void {
  db.transaction(() => {
    const tmpName = `${tableName}__rebuild_tmp`;

    const storedCols = newColumns.filter(({ def }) => !isFormula(def)) as Array<
      RebuildColumn & { def: Exclude<ColumnDef, { kind: "formula" }> }
    >;

    const colFragments = storedCols.map(({ name, def }) => buildColumnDdlFragment(name, def));
    const colsSql = colFragments.length > 0 ? `,\n  ${colFragments.join(",\n  ")}` : "";

    db.exec(
      `CREATE TABLE ${dataTableName(tmpName)} (\n  id INTEGER PRIMARY KEY AUTOINCREMENT${colsSql}\n)`,
    );

    if (storedCols.length > 0) {
      const selectExprs = storedCols.map(({ name, selectExpr }) => {
        const expr = selectExpr ?? quoteName(name);
        return `${expr} AS ${quoteName(name)}`;
      });

      const insertCols = ["id", ...storedCols.map(({ name }) => name)].map(quoteName).join(", ");

      db.exec(
        `INSERT INTO ${dataTableName(tmpName)} (${insertCols})\n` +
          `SELECT id, ${selectExprs.join(", ")} FROM ${dataTableName(tableName)}`,
      );
    } else {
      db.exec(
        `INSERT INTO ${dataTableName(tmpName)} (id) SELECT id FROM ${dataTableName(tableName)}`,
      );
    }

    db.exec(`DROP TABLE ${dataTableName(tableName)}`);
    db.exec(`ALTER TABLE ${dataTableName(tmpName)} RENAME TO ${dataTableName(tableName)}`);
  })();
}
