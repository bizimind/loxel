import type { TableSchema, Page, TableViewDef, ValidationIssue } from "@bizimind/localdb-sdk";
import type React from "react";

import { useState, useEffect } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import type { DataAdapter } from "../../adapters/data-adapter.ts";

import { getField, defaultComponentKeyForColumn } from "../../fields/registry.ts";
import { CellEditor } from "./CellEditor.tsx";

interface Props {
  schema: TableSchema;
  viewDef?: TableViewDef;
  adapter: DataAdapter;
  pageSize?: number;
}

export function DataTable({ schema, viewDef, adapter, pageSize = 50 }: Props) {
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Page<Record<string, unknown>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [addingRow, setAddingRow] = useState(false);
  const [newRow, setNewRow] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [editingCell, setEditingCell] = useState<{ rowId: number; column: string } | null>(null);
  const [editingValue, setEditingValue] = useState<unknown>(null);
  const [editingIssues, setEditingIssues] = useState<ValidationIssue[]>([]);
  const [savingCell, setSavingCell] = useState(false);

  const visibleCols = schema.columns.filter(
    (c) => c.def.kind !== "formula" && !viewDef?.hiddenColumns?.includes(c.name),
  );

  const orderedCols = viewDef?.columnOrder
    ? [
        ...viewDef.columnOrder
          .map((name) => visibleCols.find((c) => c.name === name))
          .filter(Boolean),
        ...visibleCols.filter((c) => !viewDef.columnOrder!.includes(c.name)),
      ]
    : visibleCols;

  function reload() {
    setLoading(true);
    adapter
      .query(schema.table.name, { page, pageSize })
      .then((result) => {
        setData(result as Page<Record<string, unknown>>);
        setError(null);
      })
      .catch((err: unknown) => setError(String(err)))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    reload();
  }, [schema.table.name, page, pageSize]);

  async function saveNewRow() {
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {};
      for (const col of orderedCols) {
        const v = newRow[col!.name];
        if (v !== undefined && v !== null && v !== "") payload[col!.name] = v;
      }
      const result = await adapter.insert(schema.table.name, payload);
      if (!result.ok) {
        setError(result.issues.map((i) => `${i.path.join(".")}: ${i.code}`).join("; "));
        return;
      }
      setNewRow({});
      setAddingRow(false);
      reload();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  function startAdding() {
    setAddingRow(true);
    setNewRow({});
  }

  function cancelAdding() {
    setAddingRow(false);
    setNewRow({});
  }

  function startEditing(row: Record<string, unknown>, column: string) {
    const rowId = row["id"];
    if (typeof rowId !== "number") return;
    setEditingCell({ rowId, column });
    setEditingValue(toEditableValue(row[column]));
    setEditingIssues([]);
  }

  async function commitEditing() {
    if (!editingCell || savingCell) return;
    const { rowId, column } = editingCell;
    setSavingCell(true);
    const previousData = data;
    const patchValue = toPayloadValue(editingValue);
    setData((current) =>
      current
        ? {
            ...current,
            rows: current.rows.map((row) =>
              row["id"] === rowId ? { ...row, [column]: patchValue } : row,
            ),
          }
        : current,
    );
    try {
      const result = await adapter.update<Record<string, unknown>>(schema.table.name, rowId, {
        [column]: patchValue,
      });
      if (!result.ok) {
        setData(previousData);
        setEditingIssues(result.issues.filter((issue) => issue.path[0] === column));
        return;
      }
      setData((current) =>
        current
          ? {
              ...current,
              rows: current.rows.map((row) => (row["id"] === rowId ? result.row : row)),
            }
          : current,
      );
      setEditingCell(null);
      setEditingValue(null);
      setEditingIssues([]);
      setError(null);
    } catch (err) {
      setData(previousData);
      setError(String(err));
    } finally {
      setSavingCell(false);
    }
  }

  function cancelEditing() {
    if (savingCell) return;
    setEditingCell(null);
    setEditingValue(null);
    setEditingIssues([]);
  }

  if (error) return <div className="text-destructive px-4 py-2 text-sm">Error: {error}</div>;
  if (loading) return <div className="text-muted-foreground px-4 py-2 text-sm">Loading…</div>;
  if (!data) return null;

  return (
    <div className="localdb-data-table flex flex-col">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-border border-b bg-[var(--surface-2)]/60">
              {orderedCols.map((col) => (
                <th
                  key={col!.id}
                  className="text-muted-foreground px-4 py-2.5 text-left text-[0.8125rem] font-medium whitespace-nowrap"
                >
                  {col!.def.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) => (
              <tr key={row["id"] as number} className="border-border/50 border-b">
                {orderedCols.map((col) => {
                  const colName = col!.name;
                  const rowId = row["id"] as number;
                  const isEditing = editingCell?.rowId === rowId && editingCell.column === colName;
                  const componentKey =
                    viewDef?.columnComponents?.[colName] ?? defaultComponentKeyForColumn(col!.def);
                  const registered = componentKey ? getField(componentKey) : undefined;
                  const ViewComponent = registered?.View;
                  return (
                    <td
                      key={colName}
                      onClick={() => {
                        if (!isEditing) startEditing(row, colName);
                      }}
                      className={cn(
                        "text-foreground",
                        isEditing ? "cursor-default px-2 py-1" : "cursor-text px-4 py-2",
                      )}
                    >
                      {isEditing ? (
                        <div
                          onBlur={(e) => {
                            if (e.currentTarget.contains(e.relatedTarget)) return;
                            void commitEditing();
                          }}
                        >
                          <CellEditor
                            def={col!.def}
                            componentKey={viewDef?.columnComponents?.[colName]}
                            value={editingValue}
                            onChange={setEditingValue}
                            onCommit={() => void commitEditing()}
                            onCancel={cancelEditing}
                            issues={editingIssues}
                            autoFocus
                          />
                        </div>
                      ) : ViewComponent ? (
                        <ViewComponent value={row[colName]} schema={col!.def} />
                      ) : (
                        <span>{renderCellValue(row[colName])}</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}

            {/* Inline add-row form */}
            {addingRow && (
              <tr className="border-border border-b">
                {orderedCols.map((col, i) => (
                  <td key={col!.name} className="px-2 py-1">
                    <CellEditor
                      def={col!.def}
                      componentKey={viewDef?.columnComponents?.[col!.name]}
                      value={newRow[col!.name]}
                      onChange={(v) => setNewRow((r) => ({ ...r, [col!.name]: v }))}
                      onCommit={() => void saveNewRow()}
                      onCancel={cancelAdding}
                      autoFocus={i === 0}
                    />
                  </td>
                ))}
              </tr>
            )}

            {data.rows.length === 0 && !addingRow && (
              <tr>
                <td
                  colSpan={orderedCols.length}
                  className="text-muted-foreground px-4 py-6 text-center text-sm"
                >
                  No rows
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Footer: save/cancel or add-row trigger */}
      {addingRow ? (
        <div className="border-border/50 flex gap-2 border-t px-4 py-1.5">
          <Button type="button" onClick={() => void saveNewRow()} disabled={saving} size="xs">
            {saving ? "Saving…" : "Save"}
          </Button>
          <Button type="button" onClick={cancelAdding} variant="outline" size="xs">
            Cancel
          </Button>
        </div>
      ) : (
        <button
          type="button"
          onClick={startAdding}
          className="border-border/50 text-muted-foreground hover:text-foreground w-full cursor-pointer border-t bg-transparent px-4 py-1.5 text-left text-xs"
        >
          + Add row
        </button>
      )}

      {(data.total > pageSize || page > 1) && (
        <div className="text-muted-foreground flex items-center justify-between px-4 py-1.5 text-xs">
          <span>
            {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, data.total)} of {data.total}
          </span>
          <div className="flex gap-1">
            <PagingBtn disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
              ←
            </PagingBtn>
            <PagingBtn disabled={!data.hasNext} onClick={() => setPage((p) => p + 1)}>
              →
            </PagingBtn>
          </div>
        </div>
      )}
    </div>
  );
}

/** Render a raw cell value, including hydrated InlineOption objects/arrays. */
function renderCellValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (Array.isArray(value)) {
    return value.map((v) => (isOptionObject(v) ? v.label : String(v))).join(", ") || "—";
  }
  if (isOptionObject(value)) return value.label;
  return String(value);
}

function isOptionObject(v: unknown): v is { label: string; value: unknown } {
  return typeof v === "object" && v !== null && "label" in v && "value" in v;
}

function toEditableValue(value: unknown): unknown {
  if (isOptionObject(value)) return value.value;
  if (Array.isArray(value)) return value.map(toEditableValue);
  return value;
}

function toPayloadValue(value: unknown): unknown {
  return toEditableValue(value);
}

function PagingBtn({
  disabled,
  onClick,
  children,
}: {
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button type="button" disabled={disabled} onClick={onClick} variant="outline" size="icon-xs">
      {children}
    </Button>
  );
}
