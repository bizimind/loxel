import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LocalDb } from "./index.ts";
import { openDatabase } from "./index.ts";

let db: LocalDb;
let tmpDir: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `localdb-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  db = openDatabase(join(tmpDir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("schema manager", () => {
  it("creates and lists tables", () => {
    db.schema.createTable("tasks", "Tasks", [
      { kind: "text", label: "Title", unique: true },
      { kind: "boolean", label: "Done" },
    ]);

    const tables = db.schema.listTables();
    expect(tables).toHaveLength(1);
    expect(tables[0]?.name).toBe("tasks");
    expect(tables[0]?.label).toBe("Tasks");
  });

  it("gets table schema with columns", () => {
    db.schema.createTable("tasks", "Tasks", [
      { kind: "text", label: "Title" },
      { kind: "number", label: "Priority", integer: true, min: 1, max: 5 },
    ]);

    const schema = db.schema.getTableSchema("tasks");
    expect(schema.columns).toHaveLength(2);
    expect(schema.columns[0]?.name).toBe("title");
    expect(schema.columns[1]?.name).toBe("priority");
  });

  it("drops table", () => {
    db.schema.createTable("tmp", "Tmp", []);
    expect(db.schema.listTables()).toHaveLength(1);
    db.schema.dropTable("tmp");
    expect(db.schema.listTables()).toHaveLength(0);
  });

  it("renames table", () => {
    db.schema.createTable("old_name", "Old", []);
    db.schema.renameTable("old_name", "new_name");
    const tables = db.schema.listTables();
    expect(tables[0]?.name).toBe("new_name");
  });

  it("throws for invalid table name", () => {
    expect(() => db.schema.createTable("Bad Name!", "Bad", [])).toThrow();
  });

  it("throws for labels that cannot become valid column names", () => {
    expect(() =>
      db.schema.createTable("bad_columns", "Bad", [{ kind: "text", label: "!!!" }]),
    ).toThrow();
  });

  it("throws for duplicate derived column names", () => {
    expect(() =>
      db.schema.createTable("duplicate_columns", "Duplicate", [
        { kind: "text", label: "A!" },
        { kind: "text", label: "A?" },
      ]),
    ).toThrow();
  });

  it("rolls back metadata when physical table creation fails", () => {
    db.schema.createTable("authors", "Authors", []);
    expect(() =>
      db.schema.createTable("books", "Books", [
        { kind: "ref", label: "Author", targetTable: "authors", targetColumn: "missing" },
      ]),
    ).toThrow();
    expect(db.schema.listTables().map((table) => table.name)).toEqual(["authors"]);
  });
});

describe("schema editor", () => {
  beforeEach(() => {
    db.schema.createTable("items", "Items", [{ kind: "text", label: "Name" }]);
  });

  it("adds a column", () => {
    db.schema.addColumn("items", { kind: "number", label: "Price" });
    const schema = db.schema.getTableSchema("items");
    expect(schema.columns).toHaveLength(2);
    expect(schema.columns[1]?.name).toBe("price");
  });

  it("rejects duplicate column names on add", () => {
    expect(() => db.schema.addColumn("items", { kind: "number", label: "Name" })).toThrow();
  });

  it("drops a column", () => {
    db.schema.addColumn("items", { kind: "number", label: "Price" });
    db.schema.dropColumn("items", "price");
    const schema = db.schema.getTableSchema("items");
    expect(schema.columns).toHaveLength(1);
  });

  it("renames a column", () => {
    db.schema.renameColumn("items", "name", "Item Name");
    const schema = db.schema.getTableSchema("items");
    expect(schema.columns[0]?.name).toBe("item_name");
    expect(schema.columns[0]?.def.label).toBe("Item Name");
  });

  it("plans alter column (compatible types)", () => {
    const plan = db.schema.planAlterColumn("items", "name", { kind: "longtext", label: "Name" });
    expect(plan.isDestructive).toBe(false);
    expect(plan.steps.length).toBeGreaterThan(0);
  });

  it("plans alter column (incompatible types, marks destructive)", () => {
    const plan = db.schema.planAlterColumn("items", "name", { kind: "number", label: "Name" });
    expect(plan.isDestructive).toBe(true);
    expect(plan.warnings.length).toBeGreaterThan(0);
  });

  it("applies alter column migration", () => {
    const plan = db.schema.planAlterColumn("items", "name", { kind: "longtext", label: "Name" });
    const result = db.schema.applyMigration(plan);
    expect(result.success).toBe(true);
    const schema = db.schema.getTableSchema("items");
    expect(schema.columns[0]?.def.kind).toBe("longtext");
  });
});

describe("data layer", () => {
  let columns: Array<{ name: string; def: import("./index.ts").ColumnDef; id: number }>;

  beforeEach(() => {
    db.schema.createTable("tasks", "Tasks", [
      { kind: "text", label: "Title", unique: true },
      { kind: "boolean", label: "Done", nullable: true },
      { kind: "number", label: "Priority", integer: true, min: 1, max: 5 },
      { kind: "text", label: "Tags", multi: true },
    ]);
    const schema = db.schema.getTableSchema("tasks");
    columns = schema.columns.map((c) => ({ name: c.name, def: c.def, id: c.id }));
  });

  it("inserts and retrieves a row", () => {
    const result = db.data.insert(
      "tasks",
      { title: "First task", done: false, priority: 3 },
      columns,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.row.title).toBe("First task");
    expect(result.row.id).toBeDefined();
  });

  it("returns validation issues on constraint violation", () => {
    const result = db.data.insert("tasks", { priority: 99 }, columns);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const codes = result.issues.map((i) => i.code);
    expect(codes).toContain("max");
  });

  it("enforces unique constraint", () => {
    db.data.insert("tasks", { title: "Unique" }, columns);
    const result = db.data.insert("tasks", { title: "Unique" }, columns);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.code).toBe("unique");
  });

  it("paginates results", () => {
    for (let i = 0; i < 5; i++) {
      db.data.insert("tasks", { title: `Task ${i}`, priority: i + 1 }, columns);
    }
    const page = db.data.list("tasks", columns, { page: 1, pageSize: 3 });
    expect(page.rows).toHaveLength(3);
    expect(page.total).toBe(5);
    expect(page.hasNext).toBe(true);
  });

  it("filters with eq operator", () => {
    db.data.insert("tasks", { title: "Alpha", priority: 1 }, columns);
    db.data.insert("tasks", { title: "Beta", priority: 2 }, columns);

    const page = db.data.list("tasks", columns, {
      filter: { column: "priority", op: "eq", value: 1 },
    });
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]!["title"]).toBe("Alpha");
  });

  it("rejects queries for unknown columns", () => {
    expect(() =>
      db.data.list("tasks", columns, { filter: { column: "missing", op: "eq", value: 1 } }),
    ).toThrow("Unknown query column");
  });

  it("rejects row writes with unknown columns", () => {
    expect(() => db.data.insert("tasks", { title: "Known", missing: true }, columns)).toThrow(
      "Unknown row column",
    );
  });

  it("updates a row", () => {
    const ins = db.data.insert("tasks", { title: "Old" }, columns);
    if (!ins.ok) throw new Error("Insert failed");
    const id = ins.row["id"] as number;

    const upd = db.data.update("tasks", id, { title: "New" }, columns);
    expect(upd.ok).toBe(true);
    if (!upd.ok) return;
    expect(upd.row["title"]).toBe("New");
  });

  it("deletes a row", () => {
    const ins = db.data.insert("tasks", { title: "To delete" }, columns);
    if (!ins.ok) throw new Error("Insert failed");
    const id = ins.row["id"] as number;

    db.data.delete("tasks", id);
    expect(db.data.get("tasks", id, columns)).toBeNull();
  });
});

describe("formula columns", () => {
  it("injects formula values into rows", () => {
    db.schema.createTable("orders", "Orders", [
      { kind: "number", label: "Price" },
      { kind: "number", label: "Qty" },
      { kind: "formula", label: "Total", expression: "price * qty", resultKind: "number" },
    ]);
    const schema = db.schema.getTableSchema("orders");
    const columns = schema.columns.map((c) => ({ name: c.name, def: c.def, id: c.id }));

    db.data.insert("orders", { price: 10, qty: 3 }, columns);
    const page = db.data.list("orders", columns);
    expect(page.rows[0]!["total"]).toBe(30);
  });
});

describe("formula evaluator", () => {
  it("evaluates arithmetic", () => {
    expect(db.formula.evaluate("a + b", { a: 2, b: 3 })).toBe(5);
  });

  it("throws on dangerous code", () => {
    expect(() => db.formula.evaluate("while(true){}", {})).toThrow();
  });
});

describe("inline options", () => {
  it("hydrates multi-select values in stored order", () => {
    db.schema.createTable("issues", "Issues", [
      {
        kind: "text",
        label: "Labels",
        multi: true,
        options: {
          source: "inline",
          items: [
            { value: "bug", label: "Bug", position: 0 },
            { value: "feature", label: "Feature", position: 1 },
          ],
        },
      },
    ]);
    const schema = db.schema.getTableSchema("issues");
    const columns = schema.columns.map((c) => ({ name: c.name, def: c.def, id: c.id }));

    const result = db.data.insert("issues", { labels: ["feature", "bug"] }, columns);
    expect(result.ok).toBe(true);
    const page = db.data.list("issues", columns);
    expect(page.rows[0]?.labels).toMatchObject([
      { value: "feature", label: "Feature" },
      { value: "bug", label: "Bug" },
    ]);
  });
});

describe("view manager", () => {
  let tableId: number;

  beforeEach(() => {
    const t = db.schema.createTable("tasks", "Tasks", [{ kind: "text", label: "Title" }]);
    tableId = t.id;
  });

  it("creates and retrieves a view", () => {
    const view = db.views.createView(tableId, "All Tasks", {
      type: "table",
      columnOrder: ["title"],
    });
    expect(view.id).toBeDefined();
    const fetched = db.views.getView(view.id);
    expect(fetched.name).toBe("All Tasks");
    expect(fetched.config.type).toBe("table");
  });

  it("lists views for a table", () => {
    db.views.createView(tableId, "Table View", { type: "table" });
    db.views.createView(tableId, "Form View", { type: "form" });
    expect(db.views.listViews(tableId)).toHaveLength(2);
  });

  it("updates a view", () => {
    const v = db.views.createView(tableId, "Old", { type: "table" });
    db.views.updateView(v.id, { name: "New" });
    expect(db.views.getView(v.id).name).toBe("New");
  });

  it("deletes a view", () => {
    const v = db.views.createView(tableId, "Tmp", { type: "table" });
    db.views.deleteView(v.id);
    expect(() => db.views.getView(v.id)).toThrow();
  });

  it("rejects views that reference missing columns", () => {
    expect(() =>
      db.views.createView(tableId, "Broken", { type: "kanban", groupByColumn: "missing" }),
    ).toThrow("View references unknown column");
  });

  it("preserves kanban card columns in validated view configs", () => {
    const view = db.views.createView(tableId, "Kanban", {
      type: "kanban",
      groupByColumn: "title",
      cardColumns: ["title"],
      cardTitleColumn: "title",
    });

    expect(view.config).toEqual({
      type: "kanban",
      groupByColumn: "title",
      cardColumns: ["title"],
      cardTitleColumn: "title",
    });
  });
});
