import type { Database } from "bun:sqlite";

import type { ColumnDef } from "../column-types/column-def.ts";
import { quoteName, isMulti, hasInlineOptions } from "../column-types/ddl.ts";
import { OptionsManager } from "../options/manager.ts";
import { dataTableName } from "../schema/manager.ts";

export interface ValidationIssue {
  path: string[];
  code:
    | "required"
    | "type"
    | "min"
    | "max"
    | "max_length"
    | "unique"
    | "ref_not_found"
    | "invalid_option"
    | "integer_required";
  message: string;
}

export type InsertResult<T> = { ok: true; row: T } | { ok: false; issues: ValidationIssue[] };
export type UpdateResult<T> = InsertResult<T>;

export function validateRow(
  db: Database,
  row: Record<string, unknown>,
  columns: Array<{ name: string; def: ColumnDef; id: number }>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const optionsMgr = new OptionsManager(db);

  for (const { name, def, id: columnId } of columns) {
    if (def.kind === "formula") continue;

    const value = row[name];
    const missing = value === null || value === undefined;

    if (missing) {
      if (def.nullable === false) {
        issues.push({ path: [name], code: "required", message: `"${name}" is required` });
      }
      continue;
    }

    const multi = isMulti(def);

    if (multi) {
      if (!Array.isArray(value)) {
        issues.push({ path: [name], code: "type", message: `"${name}" must be an array` });
        continue;
      }
      if (hasInlineOptions(def)) {
        const opts = optionsMgr.loadOptions(columnId);
        const validValues = new Set(opts.map((o) => String(o.value)));
        for (const v of value as (string | number)[]) {
          if (!validValues.has(String(v))) {
            issues.push({
              path: [name],
              code: "invalid_option",
              message: `"${name}": "${String(v)}" is not a valid option`,
            });
          }
        }
      }
      continue;
    }

    if (hasInlineOptions(def)) {
      const opts = optionsMgr.loadOptions(columnId);
      const validValues = new Set(opts.map((o) => String(o.value)));
      if (!validValues.has(String(value))) {
        issues.push({
          path: [name],
          code: "invalid_option",
          message: `"${name}": "${String(value)}" is not a valid option`,
        });
      }
      continue;
    }

    switch (def.kind) {
      case "boolean":
        if (typeof value !== "boolean" && value !== 0 && value !== 1) {
          issues.push({ path: [name], code: "type", message: `"${name}" must be a boolean` });
        }
        break;

      case "number": {
        if (typeof value !== "number") {
          issues.push({ path: [name], code: "type", message: `"${name}" must be a number` });
          break;
        }
        if (def.integer && !Number.isInteger(value)) {
          issues.push({
            path: [name],
            code: "integer_required",
            message: `"${name}" must be an integer`,
          });
        }
        if (def.min !== undefined && value < def.min) {
          issues.push({ path: [name], code: "min", message: `"${name}" must be >= ${def.min}` });
        }
        if (def.max !== undefined && value > def.max) {
          issues.push({ path: [name], code: "max", message: `"${name}" must be <= ${def.max}` });
        }
        break;
      }

      case "text":
        if (typeof value !== "string") {
          issues.push({ path: [name], code: "type", message: `"${name}" must be a string` });
          break;
        }
        if (def.maxLength !== undefined && value.length > def.maxLength) {
          issues.push({
            path: [name],
            code: "max_length",
            message: `"${name}" must be at most ${def.maxLength} characters`,
          });
        }
        break;

      case "longtext":
      case "color":
      case "url":
        if (typeof value !== "string") {
          issues.push({ path: [name], code: "type", message: `"${name}" must be a string` });
        }
        break;

      case "date":
        if (typeof value !== "string") {
          issues.push({ path: [name], code: "type", message: `"${name}" must be a string` });
          break;
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
          issues.push({
            path: [name],
            code: "type",
            message: `"${name}" must be in YYYY-MM-DD format`,
          });
        }
        break;

      case "datetime":
        if (typeof value !== "string") {
          issues.push({ path: [name], code: "type", message: `"${name}" must be a string` });
          break;
        }
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)) {
          issues.push({
            path: [name],
            code: "type",
            message: `"${name}" must be in YYYY-MM-DDTHH:MM format`,
          });
        }
        break;

      case "duration":
        if (typeof value !== "number") {
          issues.push({
            path: [name],
            code: "type",
            message: `"${name}" must be a number (seconds)`,
          });
          break;
        }
        if (!Number.isInteger(value) || value < 0) {
          issues.push({
            path: [name],
            code: "type",
            message: `"${name}" must be a non-negative integer`,
          });
        }
        break;

      case "ref":
        if (typeof value !== "number" && typeof value !== "bigint") {
          issues.push({ path: [name], code: "type", message: `"${name}" must be a numeric ID` });
        }
        break;

      default: {
        const _exhaustive: never = def;
        void _exhaustive;
      }
    }
  }

  return issues;
}

export function findUniqueViolations(
  db: Database,
  tableName: string,
  row: Record<string, unknown>,
  columns: Array<{ name: string; def: ColumnDef }>,
  excludeId?: number,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const { name, def } of columns) {
    if (!("unique" in def) || !(def as { unique?: boolean }).unique) continue;
    if (isMulti(def)) continue; // unique not valid with multi
    const value = row[name];
    if (value === null || value === undefined) continue;

    const idClause = excludeId !== undefined ? ` AND id != ${excludeId}` : "";
    const existing = db
      .prepare(
        `SELECT 1 FROM ${dataTableName(tableName)} WHERE ${quoteName(name)} = ?${idClause} LIMIT 1`,
      )
      .get(value as string);

    if (existing) {
      issues.push({ path: [name], code: "unique", message: `"${name}": value already exists` });
    }
  }

  return issues;
}
