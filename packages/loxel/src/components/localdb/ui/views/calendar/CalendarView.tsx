import type { TableSchema, CalendarViewDef } from "@bizimind/localdb-sdk";

import { useState, useEffect } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import type { DataAdapter } from "../../adapters/data-adapter.ts";

import { RecordForm } from "../form/RecordForm.tsx";

interface Props {
  schema: TableSchema;
  viewDef: CalendarViewDef;
  adapter: DataAdapter;
}

type Row = Record<string, unknown>;

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function CalendarView({ schema, viewDef, adapter }: Props) {
  const { dateColumn, labelColumn, endDateColumn: _endDateColumn } = viewDef;
  const tableName = schema.table.name;

  const [currentMonth, setCurrentMonth] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [openRecord, setOpenRecord] = useState<number | "new" | null>(null);
  const [newDateValue, setNewDateValue] = useState<string | null>(null);

  const firstDay = currentMonth;
  const lastDay = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 0);

  async function fetchRows() {
    setLoading(true);
    try {
      const page = await adapter.query<Row>(tableName, {
        pageSize: 1000,
        filter: {
          AND: [
            { column: dateColumn, op: "gte", value: isoDate(firstDay) },
            { column: dateColumn, op: "lte", value: isoDate(lastDay) },
          ],
        },
      });
      setRows(page.rows);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void fetchRows();
  }, [tableName, currentMonth.getTime()]);

  // Build calendar grid
  const startDow = firstDay.getDay(); // 0=Sun
  const daysInMonth = lastDay.getDate();
  const cells: Array<{ date: Date; inMonth: boolean }> = [];

  // Leading days from prev month
  for (let i = startDow - 1; i >= 0; i--) {
    const d = new Date(firstDay);
    d.setDate(d.getDate() - i - 1);
    cells.push({ date: d, inMonth: false });
  }
  // Days in month
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({
      date: new Date(currentMonth.getFullYear(), currentMonth.getMonth(), d),
      inMonth: true,
    });
  }
  // Trailing days
  const remaining = 7 - (cells.length % 7);
  if (remaining < 7) {
    for (let i = 1; i <= remaining; i++) {
      const d = new Date(lastDay);
      d.setDate(d.getDate() + i);
      cells.push({ date: d, inMonth: false });
    }
  }

  const displayCol =
    labelColumn ??
    schema.columns.find((c) => c.def.kind !== "formula" && c.name !== dateColumn)?.name;

  function prevMonth() {
    setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1));
  }
  function nextMonth() {
    setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1));
  }

  function closeOverlay() {
    setOpenRecord(null);
    setNewDateValue(null);
    void fetchRows();
  }

  const monthLabel = currentMonth.toLocaleString("default", { month: "long", year: "numeric" });

  return (
    <div className="text-xs select-none">
      {/* Header */}
      <div className="border-border flex items-center gap-2 border-b px-3 py-2">
        <Button type="button" onClick={prevMonth} variant="outline" size="xs">
          ‹
        </Button>
        <span className="flex-1 text-center font-semibold">{monthLabel}</span>
        <Button type="button" onClick={nextMonth} variant="outline" size="xs">
          ›
        </Button>
      </div>

      {/* Day name header */}
      <div className="border-border grid grid-cols-7 border-b">
        {DAY_NAMES.map((d) => (
          <div key={d} className="text-muted-foreground px-1.5 py-1 text-center text-[0.85em]">
            {d}
          </div>
        ))}
      </div>

      {/* Grid */}
      <div className="grid grid-cols-7">
        {cells.map(({ date, inMonth }) => {
          const iso = isoDate(date);
          const dayRows = rows.filter((r) => String(r[dateColumn] ?? "").slice(0, 10) === iso);
          return (
            <div
              key={iso}
              onClick={() => {
                setNewDateValue(iso);
                setOpenRecord("new");
              }}
              className={cn(
                "bg-card border-border min-h-16 cursor-pointer border-r border-b px-1.5 py-1",
                !inMonth && "opacity-35",
              )}
            >
              <div className="text-muted-foreground mb-0.5 text-[0.85em]">{date.getDate()}</div>
              {loading && inMonth && dayRows.length === 0 && null}
              {dayRows.map((r) => (
                <div
                  key={String(r.id)}
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpenRecord(r.id as number);
                  }}
                  className="bg-primary text-primary-foreground mb-0.5 cursor-pointer overflow-hidden rounded-sm px-1 py-px text-[0.8em] text-ellipsis whitespace-nowrap"
                >
                  {displayCol ? String(r[displayCol] ?? "") : `#${String(r.id)}`}
                </div>
              ))}
            </div>
          );
        })}
      </div>

      {/* Overlay */}
      {openRecord !== null && (
        <div
          className="absolute inset-0 z-10 flex items-center justify-center bg-black/30"
          onClick={closeOverlay}
        >
          <div
            className="bg-card max-w-[480px] min-w-80 rounded-lg shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <RecordForm
              schema={schema}
              adapter={adapter}
              rowId={openRecord === "new" ? undefined : openRecord}
              initialValues={
                openRecord === "new" && newDateValue ? { [dateColumn]: newDateValue } : undefined
              }
              onSuccess={closeOverlay}
              onCancel={closeOverlay}
            />
          </div>
        </div>
      )}
    </div>
  );
}
