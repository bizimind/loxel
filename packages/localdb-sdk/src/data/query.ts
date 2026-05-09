import type { Database, SQLQueryBindings } from "bun:sqlite";

import type { ColumnSpec } from "./crud.ts";

import { isFormula, quoteName } from "../column-types/ddl.ts";
import { dataTableName, validateColumnName, validateTableName } from "../schema/manager.ts";
import { parseQueryOptions } from "../validation/schemas.ts";

export type FilterOperator =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "contains"
  | "startsWith"
  | "endsWith"
  | "isNull"
  | "isNotNull";

export interface LeafCondition {
  column: string;
  op: FilterOperator;
  value?: unknown;
}

export type FilterExpr = { AND: FilterExpr[] } | { OR: FilterExpr[] } | LeafCondition;

export interface SortSpec {
  column: string;
  dir: "asc" | "desc";
}

export interface QueryOptions {
  filter?: FilterExpr;
  sort?: SortSpec[];
  select?: string[];
  page?: number;
  pageSize?: number;
}

export interface Page<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
  hasNext: boolean;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 500;
const MAX_FILTER_DEPTH = 8;

export function queryTable<T extends Record<string, unknown>>(
  db: Database,
  tableName: string,
  columns: ColumnSpec[],
  opts: QueryOptions = {},
): Page<T> {
  validateTableName(tableName);
  const parsedOpts = parseQueryOptions(opts);
  const storedColumnNames = new Set(
    columns.filter(({ def }) => !isFormula(def)).map(({ name }) => name),
  );
  storedColumnNames.add("id");
  validateQueryColumns(parsedOpts, storedColumnNames);

  const page = Math.max(1, parsedOpts.page ?? 1);
  const pageSize = Math.min(Math.max(1, parsedOpts.pageSize ?? DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
  const offset = (page - 1) * pageSize;

  const table = dataTableName(tableName);
  const selectCols =
    parsedOpts.select && parsedOpts.select.length > 0
      ? ["id", ...parsedOpts.select].map(quoteName).join(", ")
      : "*";

  const { sql: whereSql, params: whereParams } = parsedOpts.filter
    ? buildFilter(parsedOpts.filter)
    : { sql: "", params: [] };

  const whereClause = whereSql ? `WHERE ${whereSql}` : "";

  const orderClause =
    parsedOpts.sort && parsedOpts.sort.length > 0
      ? `ORDER BY ${parsedOpts.sort.map((s) => `${quoteName(s.column)} ${s.dir === "desc" ? "DESC" : "ASC"}`).join(", ")}`
      : "ORDER BY id ASC";

  const countRow = db
    .prepare(`SELECT COUNT(*) as n FROM ${table} ${whereClause}`)
    .get(...(whereParams as SQLQueryBindings[])) as { n: number };
  const total = countRow.n;

  const rows = db
    .prepare(`SELECT ${selectCols} FROM ${table} ${whereClause} ${orderClause} LIMIT ? OFFSET ?`)
    .all(...([...whereParams, pageSize, offset] as SQLQueryBindings[])) as T[];

  return { rows, total, page, pageSize, hasNext: offset + rows.length < total };
}

function validateQueryColumns(opts: QueryOptions, allowedColumns: Set<string>): void {
  for (const column of opts.select ?? []) {
    validateAllowedColumn(column, allowedColumns);
  }
  for (const sort of opts.sort ?? []) {
    validateAllowedColumn(sort.column, allowedColumns);
  }
  if (opts.filter) validateFilterColumns(opts.filter, allowedColumns, 0);
}

function validateFilterColumns(expr: FilterExpr, allowedColumns: Set<string>, depth: number): void {
  if (depth > MAX_FILTER_DEPTH) throw new Error("Filter is too deeply nested");
  if ("AND" in expr) {
    for (const child of expr.AND) validateFilterColumns(child, allowedColumns, depth + 1);
    return;
  }
  if ("OR" in expr) {
    for (const child of expr.OR) validateFilterColumns(child, allowedColumns, depth + 1);
    return;
  }
  validateAllowedColumn(expr.column, allowedColumns);
}

function validateAllowedColumn(column: string, allowedColumns: Set<string>): void {
  validateColumnName(column);
  if (!allowedColumns.has(column)) throw new Error(`Unknown query column: ${column}`);
}

function buildFilter(expr: FilterExpr): { sql: string; params: unknown[] } {
  if ("AND" in expr) {
    if (expr.AND.length === 0) return { sql: "1=1", params: [] };
    const parts = expr.AND.map(buildFilter);
    return {
      sql: `(${parts.map((p) => p.sql).join(" AND ")})`,
      params: parts.flatMap((p) => p.params),
    };
  }

  if ("OR" in expr) {
    if (expr.OR.length === 0) return { sql: "1=0", params: [] };
    const parts = expr.OR.map(buildFilter);
    return {
      sql: `(${parts.map((p) => p.sql).join(" OR ")})`,
      params: parts.flatMap((p) => p.params),
    };
  }

  return buildLeaf(expr);
}

function escapeLike(value: unknown): string {
  return String(value).replace(/[\\%_]/g, "\\$&");
}

function buildLeaf(cond: LeafCondition): { sql: string; params: unknown[] } {
  const col = quoteName(cond.column);

  switch (cond.op) {
    case "eq":
      return { sql: `${col} = ?`, params: [cond.value] };
    case "neq":
      return { sql: `${col} != ?`, params: [cond.value] };
    case "gt":
      return { sql: `${col} > ?`, params: [cond.value] };
    case "gte":
      return { sql: `${col} >= ?`, params: [cond.value] };
    case "lt":
      return { sql: `${col} < ?`, params: [cond.value] };
    case "lte":
      return { sql: `${col} <= ?`, params: [cond.value] };
    case "contains":
      return { sql: `${col} LIKE ? ESCAPE '\\'`, params: [`%${escapeLike(cond.value)}%`] };
    case "startsWith":
      return { sql: `${col} LIKE ? ESCAPE '\\'`, params: [`${escapeLike(cond.value)}%`] };
    case "endsWith":
      return { sql: `${col} LIKE ? ESCAPE '\\'`, params: [`%${escapeLike(cond.value)}`] };
    case "isNull":
      return { sql: `${col} IS NULL`, params: [] };
    case "isNotNull":
      return { sql: `${col} IS NOT NULL`, params: [] };
    default: {
      const _exhaustive: never = cond.op;
      throw new Error(`Unknown filter operator: ${String(_exhaustive)}`);
    }
  }
}
