import type { Database, SQLQueryBindings } from "bun:sqlite";

import type { ColumnDef, FormulaColumnDef, InlineOption } from "../column-types/column-def.ts";
import type { QueryOptions, Page } from "./query.ts";
import type { InsertResult, UpdateResult, ValidationIssue } from "./validate.ts";

import { quoteName, isFormula, isMulti, hasInlineOptions } from "../column-types/ddl.ts";
import { evaluateFormula } from "../formula/evaluator.ts";
import { OptionsManager } from "../options/manager.ts";
import { dataTableName, validateTableName } from "../schema/manager.ts";
import { parseRowPayload } from "../validation/schemas.ts";
import { queryTable } from "./query.ts";
import { validateRow, findUniqueViolations } from "./validate.ts";

export type ColumnSpec = { name: string; def: ColumnDef; id: number };
type Row = Record<string, unknown>;

export class DataLayer {
  private readonly optionsMgr: OptionsManager;

  constructor(private readonly db: Database) {
    this.optionsMgr = new OptionsManager(db);
  }

  list(tableName: string, columns: ColumnSpec[], opts: QueryOptions = {}): Page<Row> {
    const page = queryTable(this.db, tableName, columns, opts);
    page.rows = page.rows.map((row) => this.hydrateRow(row, columns));
    return page;
  }

  get(tableName: string, id: number, columns: ColumnSpec[]): Row | null {
    validateTableName(tableName);
    const row = this.db
      .prepare(`SELECT * FROM ${dataTableName(tableName)} WHERE id = ?`)
      .get(id) as Row | null;
    if (!row) return null;
    return this.hydrateRow(row, columns);
  }

  insert(tableName: string, row: Row, columns: ColumnSpec[]): InsertResult<Row> {
    validateTableName(tableName);
    const parsedRow = parseRowPayload(row);
    validateRowKeys(parsedRow, columns);
    const storedCols = columns.filter(({ def }) => !isFormula(def));
    const issues: ValidationIssue[] = [
      ...validateRow(this.db, parsedRow, storedCols),
      ...findUniqueViolations(this.db, tableName, parsedRow, storedCols),
    ];
    if (issues.length > 0) return { ok: false, issues };

    const prepared = this.serializeRow(parsedRow, storedCols);
    const keys = Object.keys(prepared);

    let rowId: number;
    if (keys.length === 0) {
      const result = this.db
        .prepare(`INSERT INTO ${dataTableName(tableName)} DEFAULT VALUES`)
        .run();
      rowId = Number(result.lastInsertRowid);
    } else {
      const cols = keys.map(quoteName).join(", ");
      const placeholders = keys.map(() => "?").join(", ");
      const result = this.db
        .prepare(`INSERT INTO ${dataTableName(tableName)} (${cols}) VALUES (${placeholders})`)
        .run(...(keys.map((k) => prepared[k]) as SQLQueryBindings[]));
      rowId = Number(result.lastInsertRowid);
    }

    return { ok: true, row: this.get(tableName, rowId, columns)! };
  }

  update(tableName: string, id: number, patch: Row, columns: ColumnSpec[]): UpdateResult<Row> {
    validateTableName(tableName);
    const parsedPatch = parseRowPayload(patch);
    validateRowKeys(parsedPatch, columns);
    const existing = this.get(tableName, id, columns);
    if (!existing) {
      return {
        ok: false,
        issues: [{ path: ["id"], code: "required", message: `Row ${id} not found` }],
      };
    }

    const storedCols = columns.filter(({ def }) => !isFormula(def));
    // De-hydrate existing for merging (strip option objects back to values)
    const dehydratedExisting = this.dehydrateRow(existing, storedCols);
    const merged = { ...dehydratedExisting, ...parsedPatch };
    const issues: ValidationIssue[] = [
      ...validateRow(this.db, merged, storedCols),
      ...findUniqueViolations(this.db, tableName, merged, storedCols, id),
    ];
    if (issues.length > 0) return { ok: false, issues };

    const prepared = this.serializeRow(parsedPatch, storedCols);
    const keys = Object.keys(prepared);
    if (keys.length === 0) return { ok: true, row: existing };

    const setClauses = keys.map((k) => `${quoteName(k)} = ?`).join(", ");
    this.db
      .prepare(`UPDATE ${dataTableName(tableName)} SET ${setClauses} WHERE id = ?`)
      .run(...([...keys.map((k) => prepared[k]), id] as SQLQueryBindings[]));

    return { ok: true, row: this.get(tableName, id, columns)! };
  }

  delete(tableName: string, id: number): void {
    validateTableName(tableName);
    this.db.prepare(`DELETE FROM ${dataTableName(tableName)} WHERE id = ?`).run(id);
  }

  private hydrateRow(row: Row, columns: ColumnSpec[]): Row {
    const result = { ...row };
    const formulaCols = columns.filter(({ def }) => isFormula(def)) as Array<{
      name: string;
      def: FormulaColumnDef;
      id: number;
    }>;

    for (const { name, def, id: colId } of columns) {
      if (isFormula(def)) continue;
      const raw = row[name];
      if (raw === null || raw === undefined) continue;

      if (isMulti(def)) {
        let arr: unknown[];
        if (typeof raw === "string") {
          try {
            arr = JSON.parse(raw) as unknown[];
          } catch {
            console.warn(
              `Malformed JSON in column "${name}" (row id=${String(row["id"])}), defaulting to []`,
            );
            arr = [];
          }
        } else {
          arr = raw as unknown[];
        }
        if (hasInlineOptions(def)) {
          const ids = arr as number[];
          result[name] = this.optionsMgr.resolveIdsToOptions(ids);
        } else {
          result[name] = arr;
        }
      } else if (hasInlineOptions(def)) {
        result[name] = this.optionsMgr.resolveIdToOption(raw as number);
      }

      void colId; // colId used in serializeRow; kept for symmetry
    }

    for (const { name, def } of formulaCols) {
      try {
        result[name] = evaluateFormula(def.expression, result);
      } catch {
        result[name] = null;
      }
    }

    return result;
  }

  private dehydrateRow(row: Row, columns: ColumnSpec[]): Row {
    // Convert hydrated option objects back to user-facing values for validation
    const result = { ...row };
    for (const { name, def } of columns) {
      if (isMulti(def) && hasInlineOptions(def)) {
        const arr = row[name] as InlineOption[] | undefined;
        result[name] = arr ? arr.map((o) => o.value) : [];
      } else if (hasInlineOptions(def)) {
        const opt = row[name] as InlineOption | null | undefined;
        result[name] = opt?.value ?? null;
      }
    }
    return result;
  }

  private serializeRow(row: Row, columns: ColumnSpec[]): Row {
    const result: Row = {};
    for (const { name, def, id: colId } of columns) {
      if (!(name in row)) continue;
      const value = row[name];
      if (value === null || value === undefined) {
        result[name] = null;
        continue;
      }
      if (def.kind === "formula") continue;

      if (isMulti(def)) {
        const arr = Array.isArray(value) ? value : [value];
        if (hasInlineOptions(def)) {
          const ids = (arr as (string | number)[]).map((v) => {
            const id = this.optionsMgr.resolveValueToId(colId, v);
            if (id === null) throw new Error(`Unknown option value: ${String(v)}`);
            return id;
          });
          result[name] = JSON.stringify(ids);
        } else {
          result[name] = JSON.stringify(arr);
        }
      } else if (hasInlineOptions(def)) {
        const id = this.optionsMgr.resolveValueToId(colId, value as string | number);
        if (id === null) throw new Error(`Unknown option value: ${String(value)}`);
        result[name] = id;
      } else if (def.kind === "boolean") {
        result[name] = value ? 1 : 0;
      } else {
        result[name] = value;
      }
    }
    return result;
  }
}

function validateRowKeys(row: Row, columns: ColumnSpec[]): void {
  const allowed = new Set(columns.filter(({ def }) => !isFormula(def)).map(({ name }) => name));
  for (const key of Object.keys(row)) {
    if (!allowed.has(key)) throw new Error(`Unknown row column: ${key}`);
  }
}
