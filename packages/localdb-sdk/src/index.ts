import { DataLayer } from "./data/crud.ts";
import { openDb } from "./db/connection.ts";
import { initMetaSchema } from "./db/meta-schema.ts";
import { evaluateFormula } from "./formula/evaluator.ts";
import { SchemaEditor } from "./schema/editor.ts";
import { SchemaManager } from "./schema/manager.ts";
import { ViewManager } from "./views/manager.ts";

export type {
  ColumnDef,
  InlineOption,
  OptionSet,
  PrimitiveKind,
  StoredColumnDef,
  FormulaColumnDef,
} from "./column-types/column-def.ts";

export type { TableMeta, ColumnMeta, TableSchema } from "./schema/manager.ts";
export type { MigrationPlan, MigrationResult, MigrationStep } from "./schema/migration.ts";
export type { ViewMeta } from "./views/manager.ts";
export type {
  ViewDef,
  ViewType,
  TableViewDef,
  KanbanViewDef,
  FormViewDef,
  CalendarViewDef,
  GraphViewDef,
  GanttViewDef,
} from "./views/view-types.ts";
export type { QueryOptions, FilterExpr, LeafCondition, SortSpec, Page } from "./data/query.ts";
export type { ValidationIssue, InsertResult, UpdateResult } from "./data/validate.ts";
export type { ColumnSpec } from "./data/crud.ts";

export { FormulaError } from "./formula/evaluator.ts";
export {
  columnDefSchema,
  identifierSchema,
  inlineOptionSchema,
  parseColumnDef,
  parseColumnDefs,
  parseQueryOptions,
  parseRowPayload,
  parseViewDef,
  queryOptionsSchema,
  rowPayloadSchema,
  viewDefSchema,
} from "./validation/schemas.ts";

export interface SchemaApi {
  createTable: SchemaManager["createTable"];
  dropTable: SchemaManager["dropTable"];
  renameTable: SchemaManager["renameTable"];
  listTables: SchemaManager["listTables"];
  getTableSchema: SchemaManager["getTableSchema"];
  addColumn: SchemaEditor["addColumn"];
  dropColumn: SchemaEditor["dropColumn"];
  renameColumn: SchemaEditor["renameColumn"];
  planAlterColumn: SchemaEditor["planAlterColumn"];
  applyMigration: SchemaEditor["applyMigration"];
}

export interface LocalDb {
  schema: SchemaApi;
  data: DataLayer;
  views: ViewManager;
  formula: { evaluate: typeof evaluateFormula };
  close(): void;
}

export function openDatabase(dbPath: string): LocalDb {
  const db = openDb(dbPath);
  initMetaSchema(db);

  const manager = new SchemaManager(db);
  const editor = new SchemaEditor(db);
  const data = new DataLayer(db);
  const views = new ViewManager(db);

  const schema = {
    createTable: manager.createTable.bind(manager),
    dropTable: manager.dropTable.bind(manager),
    renameTable: manager.renameTable.bind(manager),
    listTables: manager.listTables.bind(manager),
    getTableSchema: manager.getTableSchema.bind(manager),
    addColumn: editor.addColumn.bind(editor),
    dropColumn: editor.dropColumn.bind(editor),
    renameColumn: editor.renameColumn.bind(editor),
    planAlterColumn: editor.planAlterColumn.bind(editor),
    applyMigration: editor.applyMigration.bind(editor),
  };

  return { schema, data, views, formula: { evaluate: evaluateFormula }, close: () => db.close() };
}
