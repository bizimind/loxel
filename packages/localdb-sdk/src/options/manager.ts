import type { Database } from "bun:sqlite";

import type { InlineOption } from "../column-types/column-def.ts";

interface OptionRow {
  id: number;
  column_id: number;
  value: string;
  label: string;
  color: string | null;
  position: number;
}

export class OptionsManager {
  constructor(private readonly db: Database) {}

  loadOptions(columnId: number): InlineOption[] {
    const rows = this.db
      .prepare("SELECT * FROM _options WHERE column_id = ? ORDER BY position")
      .all(columnId) as OptionRow[];
    return rows.map(rowToOption);
  }

  // Syncs options from ColumnDef — upserts each item, deletes removed ones.
  // Returns updated items with ids populated.
  syncOptions(columnId: number, items: InlineOption[]): InlineOption[] {
    const existing = this.loadOptions(columnId);
    const existingByValue = new Map(existing.map((o) => [String(o.value), o]));
    const newValues = new Set(items.map((i) => String(i.value)));

    // Delete removed options
    for (const old of existing) {
      if (!newValues.has(String(old.value))) {
        this.db.prepare("DELETE FROM _options WHERE id = ?").run(old.id!);
      }
    }

    const result: InlineOption[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      const valueStr = String(item.value);
      const existingItem = existingByValue.get(valueStr);
      if (existingItem) {
        const existingId = existingItem.id!;
        this.db
          .prepare("UPDATE _options SET label = ?, color = ?, position = ? WHERE id = ?")
          .run(item.label, item.color ?? null, i, existingId);
        result.push({ ...item, id: existingId, position: i });
      } else {
        const res = this.db
          .prepare(
            "INSERT INTO _options (column_id, value, label, color, position) VALUES (?, ?, ?, ?, ?)",
          )
          .run(columnId, valueStr, item.label, item.color ?? null, i);
        result.push({ ...item, id: Number(res.lastInsertRowid), position: i });
      }
    }

    return result;
  }

  deleteOptions(columnId: number): void {
    this.db.prepare("DELETE FROM _options WHERE column_id = ?").run(columnId);
  }

  // Resolve a user-facing value (string|number) to _options.id for storage.
  resolveValueToId(columnId: number, value: string | number): number | null {
    const row = this.db
      .prepare("SELECT id FROM _options WHERE column_id = ? AND value = ?")
      .get(columnId, String(value)) as { id: number } | null;
    return row?.id ?? null;
  }

  // Resolve _options.id to full InlineOption for hydration.
  resolveIdToOption(optionId: number): InlineOption | null {
    const row = this.db
      .prepare("SELECT * FROM _options WHERE id = ?")
      .get(optionId) as OptionRow | null;
    return row ? rowToOption(row) : null;
  }

  resolveIdsToOptions(optionIds: number[]): InlineOption[] {
    if (optionIds.length === 0) return [];
    const placeholders = optionIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(`SELECT * FROM _options WHERE id IN (${placeholders})`)
      .all(...optionIds) as OptionRow[];
    const byId = new Map(rows.map((row) => [row.id, rowToOption(row)]));
    return optionIds.map((id) => byId.get(id)).filter((option): option is InlineOption => !!option);
  }
}

function rowToOption(row: OptionRow): InlineOption {
  return {
    id: row.id,
    value: row.value,
    label: row.label,
    color: row.color ?? undefined,
    position: row.position,
  };
}
