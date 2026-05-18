import type { TableSchema, GanttViewDef } from "@bizimind/localdb-sdk";
import { useState, useEffect, useRef, useCallback } from "react";

import type { DataAdapter } from "../../adapters/data-adapter.ts";

interface Props {
  schema: TableSchema;
  viewDef: GanttViewDef;
  adapter: DataAdapter;
}

type Row = Record<string, unknown>;

interface DragState {
  rowId: number;
  kind: "move" | "resize";
  startX: number;
  origStart: string;
  origEnd: string;
  pixelsPerMs: number;
}

const ROW_HEIGHT = 36;
const BAR_PADDING = 6;

function parseDate(v: unknown): Date | null {
  if (typeof v !== "string" || !v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function addMs(iso: string, deltaMs: number): string {
  const d = new Date(iso);
  d.setTime(d.getTime() + deltaMs);
  return d.toISOString().slice(0, 10);
}

export function GanttView({ schema, viewDef, adapter }: Props) {
  const { startColumn, endColumn, labelColumn, groupByColumn } = viewDef;
  const tableName = schema.table.name;

  const [localRows, setLocalRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [dragging, setDragging] = useState<DragState | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // Always reflects the latest localRows without stale closure issues in event handlers
  const localRowsRef = useRef<Row[]>(localRows);
  localRowsRef.current = localRows;

  async function fetchRows() {
    setLoading(true);
    try {
      const page = await adapter.query<Row>(tableName, { pageSize: 500 });
      setLocalRows(page.rows);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void fetchRows();
  }, [tableName]);

  // Compute time range
  const validRows = localRows.filter((r) => parseDate(r[startColumn]) && parseDate(r[endColumn]));
  const allDates = validRows.flatMap((r) => [
    parseDate(r[startColumn])!.getTime(),
    parseDate(r[endColumn])!.getTime(),
  ]);
  const rangeMin = allDates.length > 0 ? Math.min(...allDates) : Date.now();
  const rangeMax = allDates.length > 0 ? Math.max(...allDates) : Date.now() + 7 * 86400000;
  const pad = (rangeMax - rangeMin) * 0.05 + 86400000;
  const rangeStart = rangeMin - pad;
  const rangeEnd = rangeMax + pad;
  const totalMs = rangeEnd - rangeStart;

  // Sort rows by group if groupByColumn is set
  const sortedRows = groupByColumn
    ? [...validRows].sort((a, b) =>
        String(a[groupByColumn] ?? "").localeCompare(String(b[groupByColumn] ?? "")),
      )
    : validRows;

  // Build tick marks for header
  const tickCount = Math.min(12, Math.max(4, Math.floor(totalMs / 86400000 / 7)));
  const tickStep = totalMs / tickCount;
  const ticks = Array.from(
    { length: tickCount + 1 },
    (_, i) => new Date(rangeStart + i * tickStep),
  );

  const onMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!dragging || !containerRef.current) return;
      const dx = e.clientX - dragging.startX;
      const containerWidth = containerRef.current.getBoundingClientRect().width;
      const pxPerMs = containerWidth / totalMs;
      const deltaMs = dx / pxPerMs;

      setLocalRows((prev) =>
        prev.map((r) => {
          if (r.id !== dragging.rowId) return r;
          if (dragging.kind === "move") {
            return {
              ...r,
              [startColumn]: addMs(dragging.origStart, deltaMs),
              [endColumn]: addMs(dragging.origEnd, deltaMs),
            };
          }
          return { ...r, [endColumn]: addMs(dragging.origEnd, deltaMs) };
        }),
      );
    },
    [dragging, totalMs, startColumn, endColumn],
  );

  const onMouseUp = useCallback(async () => {
    if (!dragging) return;
    // Read from ref to get the post-drag state, not the stale closure value
    const current = localRowsRef.current;
    const row = current.find((r) => r.id === dragging.rowId);
    if (row) {
      const snapshot = current;
      try {
        await adapter.update<Row>(tableName, dragging.rowId, {
          [startColumn]: row[startColumn],
          [endColumn]: row[endColumn],
        });
      } catch {
        setLocalRows(snapshot);
      }
    }
    setDragging(null);
  }, [dragging, adapter, tableName, startColumn, endColumn]);

  useEffect(() => {
    if (!dragging) return;
    const handleMouseUp = () => {
      void onMouseUp();
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [dragging, onMouseMove, onMouseUp]);

  if (loading) {
    return <div className="text-muted-foreground p-4 text-xs">Loading…</div>;
  }

  if (validRows.length === 0) {
    return (
      <div className="text-muted-foreground p-4 text-center text-xs">
        No rows with valid start/end dates
      </div>
    );
  }

  const labelCol =
    labelColumn ??
    schema.columns.find(
      (c) => c.name !== startColumn && c.name !== endColumn && c.def.kind !== "formula",
    )?.name;

  let lastGroup: string | null | undefined = undefined;

  return (
    <div className="overflow-x-auto text-xs">
      {/* Time axis header */}
      <div ref={containerRef} className="border-border relative mb-0 h-6 border-b">
        {ticks.map((t) => {
          const pct = ((t.getTime() - rangeStart) / totalMs) * 100;
          return (
            <div
              key={t.getTime()}
              className="border-border text-muted-foreground absolute top-0 bottom-0 border-l pl-1 text-[0.75em] whitespace-nowrap"
              style={{ left: `${pct}%` }}
            >
              {t.toLocaleDateString("default", { month: "short", day: "numeric" })}
            </div>
          );
        })}
      </div>

      {/* Rows */}
      <div className="relative">
        {sortedRows.map((row) => {
          const group = groupByColumn ? String(row[groupByColumn] ?? "") : null;
          const showGroupHeader = groupByColumn && group !== lastGroup;
          if (showGroupHeader) lastGroup = group;

          const startMs = parseDate(row[startColumn])!.getTime();
          const endMs = parseDate(row[endColumn])!.getTime();
          const leftPct = ((startMs - rangeStart) / totalMs) * 100;
          const widthPct = ((endMs - startMs) / totalMs) * 100;

          return (
            <div key={String(row.id)}>
              {showGroupHeader && (
                <div className="bg-muted border-border text-muted-foreground border-b px-2 py-1 text-[0.85em] font-semibold">
                  {group}
                </div>
              )}
              <div className="border-border relative border-b" style={{ height: ROW_HEIGHT }}>
                {/* Label on left — optional fixed column could be added later */}
                <div
                  className="bg-primary text-primary-foreground absolute flex cursor-grab items-center overflow-hidden rounded pl-1.5 text-[0.8em] text-ellipsis whitespace-nowrap select-none"
                  style={{
                    left: `${leftPct}%`,
                    width: `${Math.max(widthPct, 0.5)}%`,
                    top: BAR_PADDING,
                    height: ROW_HEIGHT - BAR_PADDING * 2,
                  }}
                  onMouseDown={(e) => {
                    if (!containerRef.current) return;
                    const containerWidth = containerRef.current.getBoundingClientRect().width;
                    setDragging({
                      rowId: row.id as number,
                      kind: "move",
                      startX: e.clientX,
                      origStart: String(row[startColumn]),
                      origEnd: String(row[endColumn]),
                      pixelsPerMs: containerWidth / totalMs,
                    });
                    e.preventDefault();
                  }}
                >
                  <span className="flex-1 overflow-hidden text-ellipsis">
                    {labelCol ? String(row[labelCol] ?? "") : `#${String(row.id)}`}
                  </span>
                  {/* Resize handle */}
                  <div
                    className="flex h-full w-2 shrink-0 cursor-ew-resize items-center justify-center opacity-60"
                    onMouseDown={(e) => {
                      if (!containerRef.current) return;
                      const containerWidth = containerRef.current.getBoundingClientRect().width;
                      setDragging({
                        rowId: row.id as number,
                        kind: "resize",
                        startX: e.clientX,
                        origStart: String(row[startColumn]),
                        origEnd: String(row[endColumn]),
                        pixelsPerMs: containerWidth / totalMs,
                      });
                      e.stopPropagation();
                      e.preventDefault();
                    }}
                  >
                    ⋮
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
