import type { TableSchema, KanbanViewDef, InlineOption, ColumnDef } from "@bizimind/localdb-sdk";
import type React from "react";

import { useState, useEffect } from "react";

import { dayjs } from "@/lib/dayjs";

import type { DataAdapter } from "../../adapters/data-adapter.ts";

interface Props {
  schema: TableSchema;
  viewDef: KanbanViewDef;
  adapter: DataAdapter;
}

type Row = Record<string, unknown>;
type Group = { key: string; label: string; value: unknown };

export function KanbanBoard({ schema, viewDef, adapter }: Props) {
  const { groupByColumn, cardTitleColumn, cardColumns } = viewDef;
  const tableName = schema.table.name;

  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [dragging, setDragging] = useState<{ rowId: number; fromGroup: string | null } | null>(
    null,
  );

  async function fetchRows() {
    setLoading(true);
    try {
      const page = await adapter.query<Row>(tableName, { pageSize: 500 });
      setRows(page.rows);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void fetchRows();
  }, [tableName]);

  // Compute group buckets from column options or unique row values.
  const groupCol = schema.columns.find((c) => c.name === groupByColumn);
  const optionGroups: Group[] =
    groupCol?.def && "options" in groupCol.def && groupCol.def.options?.source === "inline"
      ? groupCol.def.options.items.map((o) => ({
          key: groupKey(o.value),
          label: o.label,
          value: o.value,
        }))
      : [...new Set(rows.map((r) => groupKey(rowGroupValue(r[groupByColumn]))))].map((key) => ({
          key,
          label: key === "__null__" ? "No value" : key,
          value: key === "__null__" ? null : key,
        }));

  const hasNullRows = rows.some((r) => r[groupByColumn] === null || r[groupByColumn] === undefined);
  if (!optionGroups.some((group) => group.key === "__null__") && hasNullRows) {
    optionGroups.push({ key: "__null__", label: "No value", value: null });
  }

  const titleCol = cardTitleColumn ?? schema.columns.find((c) => c.name !== groupByColumn)?.name;
  const detailCols =
    cardColumns ??
    schema.columns
      .filter((c) => c.name !== groupByColumn && c.name !== titleCol && c.def.kind !== "formula")
      .map((c) => c.name);

  const columnByName = new Map(schema.columns.map((column) => [column.name, column]));

  async function handleMove(rowId: number, newGroup: unknown) {
    const snapshot = rows;
    const optimisticGroup =
      groupCol?.def && "options" in groupCol.def && groupCol.def.options?.source === "inline"
        ? (groupCol.def.options.items.find((o) => groupKey(o.value) === groupKey(newGroup)) ?? null)
        : newGroup;
    setRows((prev) =>
      prev.map((r) => (r.id === rowId ? { ...r, [groupByColumn]: optimisticGroup } : r)),
    );
    try {
      await adapter.update<Row>(tableName, rowId, { [groupByColumn]: newGroup });
    } catch {
      setRows(snapshot);
    }
  }

  if (loading) {
    return <div className="text-muted-foreground p-4 text-xs">Loading…</div>;
  }

  return (
    <div className="localdb-kanban-board flex items-start gap-3 overflow-x-auto p-3">
      {optionGroups.map((group) => {
        const groupRows = rows.filter((r) => groupKey(r[groupByColumn]) === group.key);
        return (
          <div
            key={group.key}
            className="bg-muted border-border flex w-[200px] min-w-[200px] flex-col rounded-md border"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (dragging) void handleMove(dragging.rowId, group.value);
            }}
          >
            <div className="text-foreground border-border border-b px-2.5 py-2 text-xs font-semibold">
              {group.label}{" "}
              <span className="text-muted-foreground font-normal">({groupRows.length})</span>
            </div>
            <div className="flex max-h-[400px] flex-col gap-1.5 overflow-y-auto p-2">
              {groupRows.map((row) => (
                <div
                  key={String(row.id)}
                  draggable
                  onDragStart={() => setDragging({ rowId: row.id as number, fromGroup: group.key })}
                  onDragEnd={() => setDragging(null)}
                  className="bg-card border-border cursor-grab rounded border px-2.5 py-2 text-xs"
                >
                  {titleCol && (
                    <div className={detailCols.length > 0 ? "mb-1 font-semibold" : "font-semibold"}>
                      {renderCellValue(row[titleCol], columnByName.get(titleCol)?.def)}
                    </div>
                  )}
                  {detailCols.map((col) => {
                    const column = columnByName.get(col);
                    return (
                      <div key={col} className="text-muted-foreground text-[0.9em]">
                        <span className="opacity-70">{column?.def.label ?? col}: </span>
                        {renderCellValue(row[col], column?.def)}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function rowGroupValue(value: unknown): unknown {
  if (isInlineOption(value)) return value.value;
  return value;
}

export function groupKey(value: unknown): string {
  if (value === null || value === undefined) return "__null__";
  return String(rowGroupValue(value));
}

export function renderValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (isInlineOption(value)) return value.label;
  if (Array.isArray(value)) return value.map(renderValue).join(", ");
  return String(value);
}

export function renderCellValue(value: unknown, def?: ColumnDef): React.ReactNode {
  if (value === null || value === undefined || value === "") return "—";
  if (def?.kind === "date" || def?.kind === "datetime") {
    const parsed = dayjs(String(value));
    if (!parsed.isValid()) return String(value);
    const exactFormat = def.kind === "date" ? "YYYY-MM-DD" : "YYYY-MM-DD HH:mm:ss";
    return <span title={parsed.format(exactFormat)}>{parsed.fromNow()}</span>;
  }
  if (def?.kind === "duration") {
    return formatDuration(typeof value === "number" ? value : Number(value));
  }
  return renderValue(value);
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return "—";
  if (seconds === 0) return "0m";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  return parts.join(" ");
}

function isInlineOption(value: unknown): value is InlineOption {
  return (
    typeof value === "object" &&
    value !== null &&
    "value" in value &&
    "label" in value &&
    typeof (value as { label?: unknown }).label === "string"
  );
}
