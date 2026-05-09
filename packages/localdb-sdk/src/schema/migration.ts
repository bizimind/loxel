import type { ColumnDef } from "../column-types/column-def.ts";

export type MigrationStepKind =
  | "add_column"
  | "drop_column"
  | "rename_column"
  | "rewrite_table"
  | "backfill";

export interface MigrationStep {
  kind: MigrationStepKind;
  description: string;
}

export interface MigrationPlan {
  tableName: string;
  columnName: string;
  newDef: ColumnDef;
  steps: MigrationStep[];
  warnings: string[];
  isDestructive: boolean;
}

export interface MigrationResult {
  success: boolean;
  stepsApplied: number;
}

export function planAlterColumn(
  tableName: string,
  colName: string,
  oldDef: ColumnDef,
  newDef: ColumnDef,
): MigrationPlan {
  const warnings: string[] = [];
  const steps: MigrationStep[] = [];
  let isDestructive = false;

  const compatible = areTypesCompatible(oldDef, newDef);

  steps.push({
    kind: "rewrite_table",
    description: `Rebuild table "${tableName}" to update column "${colName}"`,
  });

  if (!compatible) {
    isDestructive = true;
    warnings.push(
      `Changing column "${colName}" from "${oldDef.kind}" to "${newDef.kind}" may lose data. ` +
        `Existing values will be coerced or set to NULL.`,
    );
    steps.push({
      kind: "backfill",
      description: `Coerce existing values in "${colName}" to new type ${newDef.kind}`,
    });
  }

  if ("unique" in oldDef && oldDef.unique && !("unique" in newDef && newDef.unique)) {
    warnings.push(`Removing UNIQUE constraint from "${colName}".`);
  }

  const oldNullable = "nullable" in oldDef ? oldDef.nullable : undefined;
  const newNullable = "nullable" in newDef ? newDef.nullable : undefined;
  if (oldNullable && !newNullable) {
    warnings.push(
      `Column "${colName}" is becoming non-nullable. Existing NULL values will need backfilling.`,
    );
    steps.push({ kind: "backfill", description: `Fill NULL values in "${colName}" with default` });
    isDestructive = true;
  }

  return { tableName, columnName: colName, newDef, steps, warnings, isDestructive };
}

/** Returns a SQL SELECT expression to coerce old value to new type during rebuild. */
export function coerceExpr(colName: string, oldDef: ColumnDef, newDef: ColumnDef): string {
  const q = `"${colName.replace(/"/g, '""')}"`;

  if (areTypesCompatible(oldDef, newDef)) return q;

  // Number/boolean → text
  if (isTextLike(newDef) && (oldDef.kind === "number" || oldDef.kind === "boolean")) {
    return `CAST(${q} AS TEXT)`;
  }

  // Text → number/boolean
  if ((newDef.kind === "number" || newDef.kind === "boolean") && isTextLike(oldDef)) {
    return `CAST(${q} AS REAL)`;
  }

  // Fallback: NULL
  return "NULL";
}

function isTextLike(def: ColumnDef): boolean {
  return ["text", "longtext", "color", "url", "date", "datetime"].includes(def.kind);
}

function areTypesCompatible(a: ColumnDef, b: ColumnDef): boolean {
  if (a.kind === b.kind) return true;
  if (
    (a.kind === "number" || a.kind === "boolean" || a.kind === "duration") &&
    (b.kind === "number" || b.kind === "boolean" || b.kind === "duration")
  ) {
    return true;
  }
  if (isTextLike(a) && isTextLike(b)) return true;
  return false;
}
