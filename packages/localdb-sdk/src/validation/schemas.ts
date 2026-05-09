import { z } from "zod";

import type { ColumnDef } from "../column-types/column-def.ts";
import type { FilterExpr, QueryOptions } from "../data/query.ts";
import type { ViewDef } from "../views/view-types.ts";

export const identifierSchema = z
  .string()
  .min(1)
  .regex(/^[a-z][a-z0-9_]*$/, "must start with a letter and contain only a-z, 0-9, _");

const baseColumnSchema = z.object({ label: z.string().min(1), nullable: z.boolean().optional() });

export const inlineOptionSchema = z.object({
  id: z.number().int().positive().optional(),
  value: z.union([z.string(), z.number()]),
  label: z.string().min(1),
  color: z.string().optional(),
  position: z.number().int().nonnegative(),
});

const optionSetSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("inline"), items: z.array(inlineOptionSchema) }),
  z.object({
    source: z.literal("ref"),
    table: identifierSchema,
    valueColumn: identifierSchema,
    labelColumn: identifierSchema,
  }),
]);

export const columnDefSchema: z.ZodType<ColumnDef> = z.discriminatedUnion("kind", [
  baseColumnSchema.extend({
    kind: z.literal("text"),
    unique: z.boolean().optional(),
    multi: z.boolean().optional(),
    maxLength: z.number().int().positive().optional(),
    options: optionSetSchema.optional(),
  }),
  baseColumnSchema.extend({ kind: z.literal("longtext") }),
  baseColumnSchema.extend({
    kind: z.literal("url"),
    unique: z.boolean().optional(),
    multi: z.boolean().optional(),
  }),
  baseColumnSchema.extend({ kind: z.literal("color"), multi: z.boolean().optional() }),
  baseColumnSchema.extend({
    kind: z.literal("number"),
    unique: z.boolean().optional(),
    multi: z.boolean().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    integer: z.boolean().optional(),
    options: optionSetSchema.optional(),
  }),
  baseColumnSchema.extend({ kind: z.literal("boolean") }),
  baseColumnSchema.extend({ kind: z.literal("date") }),
  baseColumnSchema.extend({ kind: z.literal("datetime") }),
  baseColumnSchema.extend({ kind: z.literal("duration") }),
  baseColumnSchema.extend({
    kind: z.literal("ref"),
    targetTable: identifierSchema,
    targetColumn: identifierSchema,
  }),
  z.object({
    kind: z.literal("formula"),
    label: z.string().min(1),
    expression: z.string().min(1),
    resultKind: z.enum(["boolean", "number", "text"]),
  }),
]);

const filterOperatorSchema = z.enum([
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "startsWith",
  "endsWith",
  "isNull",
  "isNotNull",
]);

type FilterSchema = z.ZodType<FilterExpr>;

const filterExprSchema: FilterSchema = z.lazy(() =>
  z.union([
    z.object({ AND: z.array(filterExprSchema).max(25) }),
    z.object({ OR: z.array(filterExprSchema).max(25) }),
    z.object({ column: identifierSchema, op: filterOperatorSchema, value: z.unknown().optional() }),
  ]),
);

export const queryOptionsSchema: z.ZodType<QueryOptions> = z.object({
  filter: filterExprSchema.optional(),
  sort: z
    .array(z.object({ column: identifierSchema, dir: z.enum(["asc", "desc"]) }))
    .max(10)
    .optional(),
  select: z.array(identifierSchema).max(100).optional(),
  page: z.number().int().positive().optional(),
  pageSize: z.number().int().positive().max(500).optional(),
});

const tableViewDefSchema = z.object({
  type: z.literal("table"),
  columnOrder: z.array(identifierSchema).optional(),
  hiddenColumns: z.array(identifierSchema).optional(),
  columnComponents: z.record(identifierSchema, z.string()).optional(),
});

const kanbanViewDefSchema = z.object({
  type: z.literal("kanban"),
  groupByColumn: identifierSchema,
  cardColumns: z.array(identifierSchema).optional(),
  cardTitleColumn: identifierSchema.optional(),
});

const formViewDefSchema = z.object({
  type: z.literal("form"),
  fieldOrder: z.array(identifierSchema).optional(),
  readonlyColumns: z.array(identifierSchema).optional(),
  hiddenColumns: z.array(identifierSchema).optional(),
});

const calendarViewDefSchema = z.object({
  type: z.literal("calendar"),
  dateColumn: identifierSchema,
  labelColumn: identifierSchema.optional(),
  endDateColumn: identifierSchema.optional(),
});

const graphViewDefSchema = z.object({
  type: z.literal("graph"),
  xColumn: identifierSchema,
  yColumn: identifierSchema,
  chartKind: z.enum(["bar", "line", "scatter", "pie"]),
  groupByColumn: identifierSchema.optional(),
});

const ganttViewDefSchema = z.object({
  type: z.literal("gantt"),
  startColumn: identifierSchema,
  endColumn: identifierSchema,
  labelColumn: identifierSchema.optional(),
  groupByColumn: identifierSchema.optional(),
});

export const viewDefSchema: z.ZodType<ViewDef> = z.discriminatedUnion("type", [
  tableViewDefSchema,
  kanbanViewDefSchema,
  formViewDefSchema,
  calendarViewDefSchema,
  graphViewDefSchema,
  ganttViewDefSchema,
]);

export const rowPayloadSchema = z.record(identifierSchema, z.unknown());

export function parseColumnDef(input: unknown): ColumnDef {
  return columnDefSchema.parse(input);
}

export function parseColumnDefs(input: unknown): ColumnDef[] {
  return z.array(columnDefSchema).parse(input);
}

export function parseQueryOptions(input: unknown): QueryOptions {
  return queryOptionsSchema.parse(input);
}

export function parseViewDef(input: unknown): ViewDef {
  return viewDefSchema.parse(input);
}

export function parseRowPayload(input: unknown): Record<string, unknown> {
  return rowPayloadSchema.parse(input);
}
