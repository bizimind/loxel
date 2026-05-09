import type { Database } from "bun:sqlite";

import type { ColumnDef } from "../column-types/column-def.ts";
import type { MigrationPlan, MigrationResult } from "./migration.ts";

import {
  buildColumnDdlFragment,
  columnToDdl,
  isFormula,
  quoteName,
  hasInlineOptions,
} from "../column-types/ddl.ts";
import { OptionsManager } from "../options/manager.ts";
import { parseColumnDef } from "../validation/schemas.ts";
import {
  SchemaManager,
  colName,
  createIndexForColumn,
  dataTableName,
  validateColumnName,
  validateColumnReferences,
  validateUniqueColumnNames,
} from "./manager.ts";
import { planAlterColumn, coerceExpr } from "./migration.ts";
import { rebuildTable } from "./rebuild.ts";

export class SchemaEditor {
  private readonly manager: SchemaManager;
  private readonly optionsMgr: OptionsManager;

  constructor(private readonly db: Database) {
    this.manager = new SchemaManager(db);
    this.optionsMgr = new OptionsManager(db);
  }

  addColumn(tableName: string, def: ColumnDef): void {
    const parsedDef = parseColumnDef(def);
    const { table, columns } = this.manager.getTableSchema(tableName);
    validateColumnReferences(this.db, [parsedDef]);
    const position = columns.length;
    const name = colName(parsedDef.label);
    validateUniqueColumnNames([...columns.map((col) => col.name), name]);

    this.db.transaction(() => {
      const res = this.db
        .prepare("INSERT INTO _columns (table_id, name, position, def) VALUES (?, ?, ?, ?)")
        .run(table.id, name, position, JSON.stringify(parsedDef));

      const columnId = Number(res.lastInsertRowid);

      if (hasInlineOptions(parsedDef)) {
        const updatedItems = this.optionsMgr.syncOptions(columnId, parsedDef.options.items);
        const updatedDef = { ...parsedDef, options: { ...parsedDef.options, items: updatedItems } };
        this.db
          .prepare("UPDATE _columns SET def = ? WHERE id = ?")
          .run(JSON.stringify(updatedDef), columnId);
      }

      if (!isFormula(parsedDef)) {
        const fragment = buildColumnDdlFragment(name, parsedDef);
        this.db.exec(`ALTER TABLE ${dataTableName(tableName)} ADD COLUMN ${fragment}`);

        const { shouldIndex } = columnToDdl(name, parsedDef);
        if (shouldIndex) {
          this.db.exec(
            `CREATE INDEX IF NOT EXISTS "idx_${tableName}_${name}" ON ${dataTableName(tableName)} (${quoteName(name)})`,
          );
        }
      }
    })();
  }

  dropColumn(tableName: string, columnName: string): void {
    validateColumnName(columnName);
    const { columns } = this.manager.getTableSchema(tableName);
    const col = columns.find((c) => c.name === columnName);
    if (!col) throw new Error(`Column "${columnName}" not found in table "${tableName}"`);

    this.db.transaction(() => {
      // CASCADE on _options handles option cleanup, but be explicit
      this.optionsMgr.deleteOptions(col.id);
      this.db.prepare("DELETE FROM _columns WHERE id = ?").run(col.id);

      if (!isFormula(col.def)) {
        const remaining = columns
          .filter((c) => c.name !== columnName)
          .map((c) => ({ name: c.name, def: c.def }));
        rebuildTable(this.db, tableName, remaining);
        for (const { name, def } of remaining) {
          if (!isFormula(def)) createIndexForColumn(this.db, tableName, name, def);
        }
      }
    })();
  }

  renameColumn(tableName: string, columnName: string, newLabel: string): void {
    validateColumnName(columnName);
    const { columns } = this.manager.getTableSchema(tableName);
    const col = columns.find((c) => c.name === columnName);
    if (!col) throw new Error(`Column "${columnName}" not found in table "${tableName}"`);

    const physicalNew = colName(newLabel);
    validateUniqueColumnNames(columns.map((c) => (c.name === columnName ? physicalNew : c.name)));
    const updatedDef = { ...col.def, label: newLabel };

    this.db.transaction(() => {
      this.db
        .prepare("UPDATE _columns SET name = ?, def = ? WHERE id = ?")
        .run(physicalNew, JSON.stringify(updatedDef), col.id);

      if (!isFormula(col.def)) {
        this.db.exec(
          `ALTER TABLE ${dataTableName(tableName)} RENAME COLUMN ${quoteName(columnName)} TO ${quoteName(physicalNew)}`,
        );
      }
    })();
  }

  planAlterColumn(tableName: string, columnName: string, newDef: ColumnDef): MigrationPlan {
    validateColumnName(columnName);
    const parsedDef = parseColumnDef(newDef);
    validateColumnReferences(this.db, [parsedDef]);
    const { columns } = this.manager.getTableSchema(tableName);
    const col = columns.find((c) => c.name === columnName);
    if (!col) throw new Error(`Column "${columnName}" not found in table "${tableName}"`);
    return planAlterColumn(tableName, columnName, col.def, parsedDef);
  }

  applyMigration(plan: MigrationPlan): MigrationResult {
    const { tableName, columnName } = plan;
    validateColumnName(columnName);
    const newDef = parseColumnDef(plan.newDef);
    validateColumnReferences(this.db, [newDef]);
    const { columns } = this.manager.getTableSchema(tableName);
    const col = columns.find((c) => c.name === columnName);
    if (!col) throw new Error(`Column "${columnName}" not found in table "${tableName}"`);

    const newColumns = columns.map((c) => {
      if (c.name !== columnName) return { name: c.name, def: c.def };
      return { name: c.name, def: newDef, selectExpr: coerceExpr(c.name, c.def, newDef) };
    });

    this.db.transaction(() => {
      rebuildTable(this.db, tableName, newColumns);
      for (const { name, def } of newColumns) {
        if (!isFormula(def)) createIndexForColumn(this.db, tableName, name, def);
      }

      let finalDef: ColumnDef = newDef;
      // Sync options if new def has inline options
      if (hasInlineOptions(newDef)) {
        const updatedItems = this.optionsMgr.syncOptions(col.id, newDef.options.items);
        finalDef = { ...newDef, options: { ...newDef.options, items: updatedItems } } as ColumnDef;
      } else {
        // Remove old options if kind changed away from inline options
        this.optionsMgr.deleteOptions(col.id);
      }

      this.db
        .prepare("UPDATE _columns SET def = ? WHERE id = ?")
        .run(JSON.stringify(finalDef), col.id);
    })();

    return { success: true, stepsApplied: plan.steps.length };
  }
}
