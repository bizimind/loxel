import type { Database } from "bun:sqlite";

import type { ViewDef, ViewType } from "./view-types.ts";

import { parseViewDef } from "../validation/schemas.ts";

export interface ViewMeta {
  id: number;
  tableId: number;
  name: string;
  type: ViewType;
  config: ViewDef;
}

interface ViewRow {
  id: number;
  table_id: number;
  name: string;
  type: string;
  config: string;
}

export class ViewManager {
  constructor(private readonly db: Database) {}

  createView(tableId: number, name: string, def: ViewDef): ViewMeta {
    const parsedDef = parseViewDef(def);
    this.validateViewDef(tableId, parsedDef);
    const result = this.db
      .prepare("INSERT INTO _views (table_id, name, type, config) VALUES (?, ?, ?, ?)")
      .run(tableId, name, parsedDef.type, JSON.stringify(parsedDef));
    return {
      id: Number(result.lastInsertRowid),
      tableId,
      name,
      type: parsedDef.type,
      config: parsedDef,
    };
  }

  updateView(id: number, patch: { name?: string; config?: ViewDef }): ViewMeta {
    const existing = this.getView(id);
    const newName = patch.name ?? existing.name;
    const newConfig = parseViewDef(patch.config ?? existing.config);
    this.validateViewDef(existing.tableId, newConfig);
    this.db
      .prepare("UPDATE _views SET name = ?, type = ?, config = ? WHERE id = ?")
      .run(newName, newConfig.type, JSON.stringify(newConfig), id);
    return { ...existing, name: newName, type: newConfig.type, config: newConfig };
  }

  deleteView(id: number): void {
    this.db.prepare("DELETE FROM _views WHERE id = ?").run(id);
  }

  listViews(tableId: number): ViewMeta[] {
    const rows = this.db
      .prepare("SELECT * FROM _views WHERE table_id = ? ORDER BY id")
      .all(tableId) as ViewRow[];
    return rows.map(rowToMeta);
  }

  getView(id: number): ViewMeta {
    const row = this.db.prepare("SELECT * FROM _views WHERE id = ?").get(id) as ViewRow | null;
    if (!row) throw new Error(`View not found: ${id}`);
    return rowToMeta(row);
  }

  private validateViewDef(tableId: number, def: ViewDef): void {
    const table = this.db.prepare("SELECT id FROM _tables WHERE id = ?").get(tableId);
    if (!table) throw new Error(`Table not found: ${tableId}`);

    const rows = this.db
      .prepare("SELECT name FROM _columns WHERE table_id = ?")
      .all(tableId) as Array<{ name: string }>;
    const columns = new Set(rows.map((row) => row.name));
    for (const column of referencedColumns(def)) {
      if (!columns.has(column)) throw new Error(`View references unknown column: ${column}`);
    }
  }
}

function referencedColumns(def: ViewDef): string[] {
  switch (def.type) {
    case "table":
      return [
        ...(def.columnOrder ?? []),
        ...(def.hiddenColumns ?? []),
        ...Object.keys(def.columnComponents ?? {}),
      ];
    case "kanban":
      return [def.groupByColumn, ...(def.cardColumns ?? []), def.cardTitleColumn].filter(
        (c): c is string => !!c,
      );
    case "form":
      return [
        ...(def.fieldOrder ?? []),
        ...(def.readonlyColumns ?? []),
        ...(def.hiddenColumns ?? []),
      ];
    case "calendar":
      return [def.dateColumn, def.labelColumn, def.endDateColumn].filter((c): c is string => !!c);
    case "graph":
      return [def.xColumn, def.yColumn, def.groupByColumn].filter((c): c is string => !!c);
    case "gantt":
      return [def.startColumn, def.endColumn, def.labelColumn, def.groupByColumn].filter(
        (c): c is string => !!c,
      );
    default: {
      const _exhaustive: never = def;
      void _exhaustive;
      return [];
    }
  }
}

function rowToMeta(row: ViewRow): ViewMeta {
  const config = parseViewDef(JSON.parse(row.config));
  return { id: row.id, tableId: row.table_id, name: row.name, type: config.type, config };
}
