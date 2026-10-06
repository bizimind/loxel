# localdb-sdk

Local, SQLite-backed structured database SDK with Notion-like typed columns, schema migrations, saved views, and formula columns. Built on `bun:sqlite`, so it runs under Bun only. Used by the [loxel](../loxel) server (one database per project under its state dir, served over REST) and, for types and validation schemas, by loxel's localdb UI components.

Workspace-only; add `"@bizimind/localdb-sdk": "workspace:*"`. Everything public is exported from [`src/index.ts`](src/index.ts).

## Usage

```typescript
import { openDatabase } from "@bizimind/localdb-sdk";

const db = openDatabase("/path/to/localdb.db"); // creates the file and parent dirs

db.schema.createTable("tasks", "Tasks", [
  { kind: "text", label: "Title" },
  { kind: "boolean", label: "Done" },
]);

const { columns } = db.schema.getTableSchema("tasks");
db.data.insert("tasks", { title: "Write docs", done: false }, columns);
const page = db.data.list("tasks", columns, { filter: { column: "done", op: "eq", value: false } });

db.close();
```

## API at a glance

`openDatabase(path)` returns a `LocalDb` with:

- `schema` — create, drop, rename, list, and describe tables; add, drop, and rename columns; `planAlterColumn()` returns a `MigrationPlan` to review before `applyMigration()` runs it.
- `data` — `list` (filter tree of `AND`/`OR` conditions, sort, select, pagination), `get`, `insert`, `update`, `delete`. Writes are validated against the column definitions: invalid column values and uniqueness violations come back as `{ ok: false, issues }` (`ValidationIssue`s), while malformed requests (an invalid table name or payload, an unknown column, or an unknown option value) throw.
- `views` — saved view configs (`table`, `kanban`, `form`, `calendar`, `graph`, `gantt`) per table.
- `formula.evaluate(expression, row)` — evaluates a formula column expression against a row.

Column kinds (`ColumnDef` in `src/column-types/column-def.ts`; column names are derived from labels, e.g. `Title` → `title`): `text`, `longtext`, `url`, `color`, `number`, `boolean`, `date`, `datetime`, `duration`, `ref`, and computed `formula`. Text and number columns can carry option sets (inline, or referencing another table). Zod schemas for column definitions, view definitions, query options, and row payloads are exported for validating untrusted input (`src/validation/schemas.ts`).

Table metadata is stored in `_tables`, `_columns`, `_options`, and `_views` alongside the data tables in the same SQLite file.

## Development

```bash
pnpm -C packages/localdb-sdk run test
pnpm -C packages/localdb-sdk run typecheck
```
