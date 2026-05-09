import type { ColumnDef, StoredColumnDef } from "./column-def.ts";

export interface ColumnDdl {
  sqlType: string;
  shouldIndex: boolean;
  constraints: string[];
}

export function columnToDdl(name: string, def: StoredColumnDef): ColumnDdl {
  const constraints: string[] = [];
  let sqlType: string;
  let shouldIndex = true;

  if (isMulti(def)) {
    // multi → JSON TEXT array
    sqlType = "TEXT";
    return { sqlType, shouldIndex, constraints };
  }

  if (hasOptions(def)) {
    // options (single) → INTEGER FK to _options
    sqlType = "INTEGER";
    if ("unique" in def && def.unique) constraints.push("UNIQUE");
    return { sqlType, shouldIndex, constraints };
  }

  switch (def.kind) {
    case "boolean":
      sqlType = "INTEGER";
      break;
    case "number":
      sqlType = def.integer ? "INTEGER" : "REAL";
      if (def.unique) constraints.push("UNIQUE");
      break;
    case "longtext":
      sqlType = "TEXT";
      shouldIndex = false;
      break;
    case "text":
      sqlType = "TEXT";
      if (def.unique) constraints.push("UNIQUE");
      break;
    case "color":
    case "url":
      sqlType = "TEXT";
      if ("unique" in def && (def as { unique?: boolean }).unique) constraints.push("UNIQUE");
      break;
    case "date":
    case "datetime":
      sqlType = "TEXT";
      break;
    case "duration":
      sqlType = "INTEGER";
      shouldIndex = false;
      break;
    case "ref":
      sqlType = "INTEGER";
      constraints.push(
        `REFERENCES ${quoteDataTableName(def.targetTable)} (${quoteName(def.targetColumn)}) ON DELETE SET NULL ON UPDATE CASCADE`,
      );
      break;
    default: {
      const _exhaustive: never = def;
      throw new Error(
        `Unknown column kind: ${String((_exhaustive as Record<string, unknown>)["kind"])}`,
      );
    }
  }

  return { sqlType, shouldIndex, constraints };
}

export function buildColumnDdlFragment(name: string, def: StoredColumnDef): string {
  const { sqlType, constraints } = columnToDdl(name, def);
  return [quoteName(name), sqlType, ...constraints].join(" ");
}

export function quoteName(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function quoteDataTableName(tableName: string): string {
  return `"data_${tableName.replace(/"/g, '""')}"`;
}

export function isFormula(def: ColumnDef): def is Extract<ColumnDef, { kind: "formula" }> {
  return def.kind === "formula";
}

export function isMulti(def: ColumnDef): boolean {
  return "multi" in def && (def as { multi?: boolean }).multi === true;
}

export function hasOptions(def: ColumnDef): boolean {
  return "options" in def && (def as { options?: unknown }).options !== undefined;
}

export type InlineOptionsDef = ColumnDef & {
  options: { source: "inline"; items: import("./column-def.ts").InlineOption[] };
};

export function hasInlineOptions(def: ColumnDef): def is InlineOptionsDef {
  return "options" in def && (def as { options?: { source: string } }).options?.source === "inline";
}

export function hasRefOptions(def: ColumnDef): boolean {
  return "options" in def && (def as { options?: { source: string } }).options?.source === "ref";
}
