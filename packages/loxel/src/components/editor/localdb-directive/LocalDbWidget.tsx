import type {
  TableMeta,
  TableViewDef,
  KanbanViewDef,
  FormViewDef,
  CalendarViewDef,
  GraphViewDef,
  GanttViewDef,
  ViewDef,
} from "@bizimind/localdb-sdk";
import type React from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { SettingsIcon } from "lucide-react";
import { useEffect, useState } from "react";

import {
  makeRestAdapter,
  DataTable,
  RecordForm,
  KanbanBoard,
  CalendarView,
  GraphView,
  GanttView,
  compatibleFields,
  defaultComponentKey,
} from "@/components/localdb/ui";
import { Button } from "@/components/ui/button";
import { onLoxelEvent } from "@/lib/loxel-events";
import { cn } from "@/lib/utils";
import { useQueryScope } from "@/queries/use-scope";

interface Props {
  table: string;
  view: string;
  viewId: number | null;
  onUpdateAttrs: (attrs: { table?: string; view?: string; viewId?: number | null }) => void;
}

const VIEW_KINDS = ["table", "kanban", "form", "calendar", "graph", "gantt"] as const;

function buildViewDef(type: string, partial: Partial<ViewDef>): ViewDef {
  switch (type) {
    case "table":
      return { type: "table", ...(partial as Partial<TableViewDef>) };
    case "kanban":
      return {
        type: "kanban",
        groupByColumn: "",
        ...(partial as Partial<KanbanViewDef>),
      } as KanbanViewDef;
    case "form":
      return { type: "form", ...(partial as Partial<FormViewDef>) };
    case "calendar":
      return {
        type: "calendar",
        dateColumn: "",
        ...(partial as Partial<CalendarViewDef>),
      } as CalendarViewDef;
    case "graph":
      return {
        type: "graph",
        xColumn: "",
        yColumn: "",
        chartKind: "bar",
        ...(partial as Partial<GraphViewDef>),
      } as GraphViewDef;
    case "gantt":
      return {
        type: "gantt",
        startColumn: "",
        endColumn: "",
        ...(partial as Partial<GanttViewDef>),
      } as GanttViewDef;
    default:
      return { type: "table" };
  }
}

function isApplyValid(type: string, config: Partial<ViewDef>): boolean {
  switch (type) {
    case "table":
    case "form":
      return true;
    case "kanban":
      return !!(config as Partial<KanbanViewDef>).groupByColumn;
    case "calendar":
      return !!(config as Partial<CalendarViewDef>).dateColumn;
    case "graph":
      return (
        !!(config as Partial<GraphViewDef>).xColumn && !!(config as Partial<GraphViewDef>).yColumn
      );
    case "gantt":
      return (
        !!(config as Partial<GanttViewDef>).startColumn &&
        !!(config as Partial<GanttViewDef>).endColumn
      );
    default:
      return true;
  }
}

export function LocalDbWidget({ table, view, viewId, onUpdateAttrs }: Props) {
  const { activeProjectPath } = useQueryScope();
  const queryClient = useQueryClient();
  const adapter = makeRestAdapter("/api/localdb", activeProjectPath);
  const [configOpen, setConfigOpen] = useState(false);
  const [pendingTable, setPendingTable] = useState(table);
  const [pendingView, setPendingView] = useState(view || "table");
  const [pendingViewConfig, setPendingViewConfig] = useState<Partial<ViewDef>>({});
  const [savingView, setSavingView] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [dataVersion, setDataVersion] = useState(0);

  useEffect(() => {
    return onLoxelEvent("loxel-localdb-changed", (event) => {
      if (event.projectPath !== activeProjectPath) return;
      if (event.tableName && event.tableName !== table) return;
      setDataVersion((version) => version + 1);
    });
  }, [activeProjectPath, table]);

  const tablesQuery = useQuery({
    queryKey: ["localdb", activeProjectPath, "tables"],
    queryFn: () => adapter.listTables(),
    enabled: !!activeProjectPath && (configOpen || !table),
  });

  const schemaQuery = useQuery({
    queryKey: ["localdb", activeProjectPath, "schema", table],
    queryFn: () => adapter.getSchema(table),
    enabled: !!table && !!activeProjectPath,
  });
  // Separate query for the pending table selection in config overlay (may differ from committed table)
  const pendingSchemaQuery = useQuery({
    queryKey: ["localdb", activeProjectPath, "schema", pendingTable],
    queryFn: () => adapter.getSchema(pendingTable),
    enabled: configOpen && !!pendingTable && !!activeProjectPath && pendingTable !== table,
  });
  // Use pending schema in overlay when available; fall back to committed schema
  const configSchema =
    configOpen && pendingSchemaQuery.data ? pendingSchemaQuery.data : schemaQuery.data;

  const viewsQuery = useQuery({
    queryKey: ["localdb", activeProjectPath, "views", schemaQuery.data?.table.id],
    queryFn: () => adapter.listViews(schemaQuery.data!.table.id),
    enabled: !!schemaQuery.data,
  });

  const currentViewMeta = viewsQuery.data?.find((v) => v.id === viewId);

  function openConfig() {
    setPendingTable(table);
    setPendingView(view || "table");
    setPendingViewConfig(currentViewMeta?.config ?? {});
    setSaveError(null);
    setConfigOpen(true);
  }

  async function applyConfig() {
    if (!pendingTable || !configSchema) return;
    setSavingView(true);
    setSaveError(null);
    try {
      const config = buildViewDef(pendingView, pendingViewConfig);
      const existingViewId =
        currentViewMeta?.tableId === configSchema.table.id ? currentViewMeta.id : undefined;
      const saved = await adapter.upsertView({
        tableId: configSchema.table.id,
        name: "default",
        type: pendingView as import("@bizimind/localdb-sdk").ViewType,
        config,
        ...(existingViewId ? { id: existingViewId } : {}),
      });
      queryClient.setQueryData(
        ["localdb", activeProjectPath, "views", saved.tableId],
        (existing: typeof viewsQuery.data) => {
          const views = existing ?? [];
          const index = views.findIndex((v) => v.id === saved.id);
          if (index === -1) return [...views, saved];
          return views.map((v) => (v.id === saved.id ? saved : v));
        },
      );
      onUpdateAttrs({ table: pendingTable, view: pendingView, viewId: saved.id });
      setConfigOpen(false);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingView(false);
    }
  }

  function renderView() {
    if (!schemaQuery.data) return null;
    const schema = schemaQuery.data;

    switch (view) {
      case "table": {
        const vd =
          currentViewMeta?.config?.type === "table"
            ? (currentViewMeta.config as TableViewDef)
            : undefined;
        return (
          <DataTable
            key={`${schema.table.name}:table:${dataVersion}`}
            schema={schema}
            viewDef={vd}
            adapter={adapter}
            pageSize={10}
          />
        );
      }
      case "kanban": {
        const vd = currentViewMeta?.config as KanbanViewDef | undefined;
        if (!vd?.groupByColumn) return <MissingConfig onConfig={openConfig} />;
        return (
          <KanbanBoard
            key={`${schema.table.name}:kanban:${dataVersion}`}
            schema={schema}
            viewDef={vd}
            adapter={adapter}
          />
        );
      }
      case "form": {
        const vd = currentViewMeta?.config as FormViewDef | undefined;
        return (
          <RecordForm
            key={`${schema.table.name}:form`}
            schema={schema}
            viewDef={vd}
            adapter={adapter}
          />
        );
      }
      case "calendar": {
        const vd = currentViewMeta?.config as CalendarViewDef | undefined;
        if (!vd?.dateColumn) return <MissingConfig onConfig={openConfig} />;
        return (
          <CalendarView
            key={`${schema.table.name}:calendar:${dataVersion}`}
            schema={schema}
            viewDef={vd}
            adapter={adapter}
          />
        );
      }
      case "graph": {
        const vd = currentViewMeta?.config as GraphViewDef | undefined;
        if (!vd?.xColumn || !vd?.yColumn) return <MissingConfig onConfig={openConfig} />;
        return (
          <GraphView
            key={`${schema.table.name}:graph:${dataVersion}`}
            schema={schema}
            viewDef={vd}
            adapter={adapter}
          />
        );
      }
      case "gantt": {
        const vd = currentViewMeta?.config as GanttViewDef | undefined;
        if (!vd?.startColumn || !vd?.endColumn) return <MissingConfig onConfig={openConfig} />;
        return (
          <GanttView
            key={`${schema.table.name}:gantt:${dataVersion}`}
            schema={schema}
            viewDef={vd}
            adapter={adapter}
          />
        );
      }
      default:
        return (
          <DataTable
            key={`${schema.table.name}:default:${dataVersion}`}
            schema={schema}
            adapter={adapter}
            pageSize={10}
          />
        );
    }
  }

  if (!activeProjectPath) {
    return <WidgetShell label="No project" onConfig={openConfig} />;
  }

  if (!table) {
    return (
      <WidgetShell label="Database Widget" onConfig={openConfig}>
        <div className="px-4 py-5 text-center">
          <p className="text-muted-foreground mb-2.5 text-xs">Select a table to display</p>
          {tablesQuery.isLoading && <span className="text-muted-foreground text-xs">Loading…</span>}
          <div className="flex flex-wrap justify-center gap-1.5">
            {tablesQuery.data?.map((t) => (
              <TableChip
                key={t.name}
                table={t}
                onClick={() => onUpdateAttrs({ table: t.name, view: pendingView })}
              />
            ))}
          </div>
        </div>
      </WidgetShell>
    );
  }

  const tableLabel = schemaQuery.data?.table.label ?? table;

  return (
    <WidgetShell label={tableLabel} onConfig={openConfig}>
      {configOpen && schemaQuery.data && (
        <ConfigOverlay
          tables={tablesQuery.data ?? []}
          schema={configSchema ?? schemaQuery.data}
          pendingTable={pendingTable}
          pendingView={pendingView}
          pendingViewConfig={pendingViewConfig}
          onTableChange={setPendingTable}
          onViewChange={(v) => {
            setPendingView(v);
            setPendingViewConfig({});
          }}
          onConfigChange={(patch) => setPendingViewConfig((prev) => ({ ...prev, ...patch }))}
          onApply={() => void applyConfig()}
          onClose={() => setConfigOpen(false)}
          saving={savingView}
          applyValid={isApplyValid(pendingView, pendingViewConfig)}
          error={saveError}
        />
      )}
      {!configOpen && schemaQuery.isLoading && (
        <div className="text-muted-foreground p-3 text-xs">Loading…</div>
      )}
      {!configOpen && schemaQuery.data && renderView()}
      {!configOpen && !schemaQuery.isLoading && !schemaQuery.data && (
        <div className="text-destructive p-3 text-xs">Table not found: {table}</div>
      )}
    </WidgetShell>
  );
}

function MissingConfig({ onConfig }: { onConfig: () => void }) {
  return (
    <div className="text-muted-foreground px-4 py-5 text-center text-xs">
      <p className="mb-2">This view needs configuration.</p>
      <Button type="button" onClick={onConfig} variant="outline" size="xs">
        Configure
      </Button>
    </div>
  );
}

function WidgetShell({
  label,
  onConfig,
  children,
}: {
  label: string;
  onConfig: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div
      className="localdb-widget border-border bg-card my-3 overflow-hidden rounded-md border text-xs"
      contentEditable={false}
    >
      <div className="bg-muted text-muted-foreground border-border flex h-6 items-center gap-1.5 border-b px-2 font-mono text-xs">
        <span className="opacity-50">:::localdb</span>
        <span className="flex-1">{label}</span>
        <Button
          type="button"
          onClick={onConfig}
          title="Configure widget"
          variant="ghost"
          size="icon-xs"
          className="size-5 p-0"
        >
          <SettingsIcon className="size-3" />
        </Button>
      </div>
      {children}
    </div>
  );
}

function TableChip({ table, onClick }: { table: TableMeta; onClick: () => void }) {
  return (
    <Button type="button" onClick={onClick} variant="outline" size="xs">
      {table.label}
    </Button>
  );
}

function ConfigOverlay({
  tables,
  schema,
  pendingTable,
  pendingView,
  pendingViewConfig,
  onTableChange,
  onViewChange,
  onConfigChange,
  onApply,
  onClose,
  saving,
  applyValid,
  error,
}: {
  tables: TableMeta[];
  schema: import("@bizimind/localdb-sdk").TableSchema;
  pendingTable: string;
  pendingView: string;
  pendingViewConfig: Partial<ViewDef>;
  onTableChange: (t: string) => void;
  onViewChange: (v: string) => void;
  onConfigChange: (patch: Partial<ViewDef>) => void;
  onApply: () => void;
  onClose: () => void;
  saving: boolean;
  applyValid: boolean;
  error: string | null;
}) {
  const cols = schema.columns.filter((c) => c.def.kind !== "formula");
  const dateCols = schema.columns.filter((c) => c.def.kind === "date" || c.def.kind === "datetime");
  const numberCols = schema.columns.filter((c) => c.def.kind === "number");

  function colSelect(
    value: string,
    onChange: (v: string) => void,
    options: typeof cols,
    placeholder = "— select —",
  ) {
    return (
      <ConfigSelect value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{placeholder}</option>
        {options.map((c) => (
          <option key={c.name} value={c.name}>
            {c.def.label}
          </option>
        ))}
      </ConfigSelect>
    );
  }

  const cfg = pendingViewConfig as Record<string, unknown>;

  function renderViewConfig() {
    switch (pendingView) {
      case "table":
        return (
          <div>
            <ConfigLabel>Column display components</ConfigLabel>
            <div className="flex flex-col gap-1">
              {cols.map((col) => {
                const options = compatibleFields(col.def.kind);
                const tableConfig = pendingViewConfig as Partial<TableViewDef>;
                const current =
                  tableConfig.columnComponents?.[col.name] ??
                  defaultComponentKey(col.def.kind) ??
                  "";
                return (
                  <div key={col.name} className="grid grid-cols-2 items-center gap-1.5">
                    <span className="text-foreground text-xs">{col.def.label}</span>
                    <ConfigSelect
                      value={current}
                      onChange={(e) => {
                        const tableConf = pendingViewConfig as Partial<TableViewDef>;
                        const next = { ...(tableConf.columnComponents ?? {}) };
                        if (e.target.value) next[col.name] = e.target.value;
                        else delete next[col.name];
                        onConfigChange({ columnComponents: next } as Partial<TableViewDef>);
                      }}
                      disabled={options.length === 0}
                    >
                      {options.length === 0 && <option value="">default</option>}
                      {options.map((f) => (
                        <option key={f.key} value={f.key}>
                          {f.label}
                        </option>
                      ))}
                    </ConfigSelect>
                  </div>
                );
              })}
            </div>
          </div>
        );

      case "kanban":
        return (
          <div className="flex flex-col gap-2">
            <div>
              <ConfigLabel>Group by column *</ConfigLabel>
              {colSelect(
                String(cfg.groupByColumn ?? ""),
                (v) => onConfigChange({ groupByColumn: v } as Partial<KanbanViewDef>),
                cols,
              )}
            </div>
            <div>
              <ConfigLabel>Card title column</ConfigLabel>
              {colSelect(
                String(cfg.cardTitleColumn ?? ""),
                (v) =>
                  onConfigChange({ cardTitleColumn: v || undefined } as Partial<KanbanViewDef>),
                cols,
              )}
            </div>
          </div>
        );

      case "form":
        return (
          <div className="text-muted-foreground text-xs">
            Form view renders all non-hidden columns. No additional config needed.
          </div>
        );

      case "calendar":
        return (
          <div className="flex flex-col gap-2">
            <div>
              <ConfigLabel>Date column *</ConfigLabel>
              {colSelect(
                String(cfg.dateColumn ?? ""),
                (v) => onConfigChange({ dateColumn: v } as Partial<CalendarViewDef>),
                dateCols.length > 0 ? dateCols : cols,
              )}
            </div>
            <div>
              <ConfigLabel>Label column</ConfigLabel>
              {colSelect(
                String(cfg.labelColumn ?? ""),
                (v) => onConfigChange({ labelColumn: v || undefined } as Partial<CalendarViewDef>),
                cols,
              )}
            </div>
          </div>
        );

      case "graph":
        return (
          <div className="flex flex-col gap-2">
            <div>
              <ConfigLabel>X axis column *</ConfigLabel>
              {colSelect(
                String(cfg.xColumn ?? ""),
                (v) => onConfigChange({ xColumn: v } as Partial<GraphViewDef>),
                cols,
              )}
            </div>
            <div>
              <ConfigLabel>Y axis column (numeric) *</ConfigLabel>
              {colSelect(
                String(cfg.yColumn ?? ""),
                (v) => onConfigChange({ yColumn: v } as Partial<GraphViewDef>),
                numberCols.length > 0 ? numberCols : cols,
              )}
            </div>
            <div>
              <ConfigLabel>Chart type</ConfigLabel>
              <ConfigSelect
                value={String(cfg.chartKind ?? "bar")}
                onChange={(e) =>
                  onConfigChange({
                    chartKind: e.target.value as GraphViewDef["chartKind"],
                  } as Partial<GraphViewDef>)
                }
              >
                {(["bar", "line", "scatter", "pie"] as const).map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </ConfigSelect>
            </div>
            <div>
              <ConfigLabel>Group by column</ConfigLabel>
              {colSelect(
                String(cfg.groupByColumn ?? ""),
                (v) => onConfigChange({ groupByColumn: v || undefined } as Partial<GraphViewDef>),
                cols,
              )}
            </div>
          </div>
        );

      case "gantt":
        return (
          <div className="flex flex-col gap-2">
            <div>
              <ConfigLabel>Start column * (date/datetime)</ConfigLabel>
              {colSelect(
                String(cfg.startColumn ?? ""),
                (v) => onConfigChange({ startColumn: v } as Partial<GanttViewDef>),
                dateCols.length > 0 ? dateCols : cols,
              )}
            </div>
            <div>
              <ConfigLabel>End column * (date/datetime)</ConfigLabel>
              {colSelect(
                String(cfg.endColumn ?? ""),
                (v) => onConfigChange({ endColumn: v } as Partial<GanttViewDef>),
                dateCols.length > 0 ? dateCols : cols,
              )}
            </div>
            <div>
              <ConfigLabel>Label column</ConfigLabel>
              {colSelect(
                String(cfg.labelColumn ?? ""),
                (v) => onConfigChange({ labelColumn: v || undefined } as Partial<GanttViewDef>),
                cols,
              )}
            </div>
            <div>
              <ConfigLabel>Group by column</ConfigLabel>
              {colSelect(
                String(cfg.groupByColumn ?? ""),
                (v) => onConfigChange({ groupByColumn: v || undefined } as Partial<GanttViewDef>),
                cols,
              )}
            </div>
          </div>
        );

      default:
        return null;
    }
  }

  return (
    <div className="bg-muted border-border flex flex-col gap-2.5 border-b p-3">
      {/* Table + View row */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <ConfigLabel>Table</ConfigLabel>
          <ConfigSelect value={pendingTable} onChange={(e) => onTableChange(e.target.value)}>
            <option value="">— select —</option>
            {tables.map((t) => (
              <option key={t.name} value={t.name}>
                {t.label}
              </option>
            ))}
          </ConfigSelect>
        </div>
        <div>
          <ConfigLabel>View</ConfigLabel>
          <ConfigSelect value={pendingView} onChange={(e) => onViewChange(e.target.value)}>
            {VIEW_KINDS.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </ConfigSelect>
        </div>
      </div>

      {/* Per-view config */}
      {renderViewConfig()}

      {error && (
        <div className="bg-destructive/10 text-destructive rounded px-2 py-1.5 text-xs">
          {error}
        </div>
      )}

      {/* Actions */}
      <div className="flex justify-end gap-1.5">
        <Button type="button" onClick={onClose} variant="outline" size="xs">
          Cancel
        </Button>
        <Button
          type="button"
          onClick={onApply}
          disabled={!pendingTable || !applyValid || saving}
          size="xs"
        >
          {saving ? "Saving…" : "Apply"}
        </Button>
      </div>
    </div>
  );
}

function ConfigLabel({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      className={cn("text-muted-foreground mb-1 block font-sans text-[0.7em]", className)}
      {...props}
    />
  );
}

function ConfigSelect({ className, ...props }: React.ComponentProps<"select">) {
  return (
    <select
      className={cn(
        "border-border text-foreground w-full rounded border bg-[var(--surface-2)] px-2 py-1 text-xs disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
