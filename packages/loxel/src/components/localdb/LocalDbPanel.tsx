import type { TableMeta, MigrationPlan } from "@bizimind/localdb-sdk";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { MigrationReview, makeRestAdapter } from "@/components/localdb/ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useQueryScope } from "@/queries/use-scope";

import { DataTable } from "./DataTable";
import { SchemaBuilder } from "./SchemaBuilder";

/** Adapter scoped to the active project via ?project= query param. */
function useLocalDbAdapter() {
  const { activeProjectPath } = useQueryScope();
  return makeRestAdapter("/api/localdb", activeProjectPath);
}

export function LocalDbPanel() {
  const { activeProjectPath } = useQueryScope();
  const adapter = useLocalDbAdapter();
  const queryClient = useQueryClient();
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [view, setView] = useState<"data" | "schema">("data");
  const [pendingPlan, setPendingPlan] = useState<MigrationPlan | null>(null);
  const [newTableForm, setNewTableForm] = useState<{ name: string; label: string } | null>(null);

  const tablesQuery = useQuery({
    queryKey: ["localdb", activeProjectPath, "tables"],
    queryFn: () => adapter.listTables(),
    enabled: !!activeProjectPath,
  });

  const schemaQuery = useQuery({
    queryKey: ["localdb", activeProjectPath, "schema", selectedTable],
    queryFn: () => adapter.getSchema(selectedTable!),
    enabled: !!selectedTable,
  });

  const createTableMutation = useMutation({
    mutationFn: async (form: { name: string; label: string }) => {
      const res = await fetch(
        `/api/localdb/tables?project=${encodeURIComponent(activeProjectPath ?? "")}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: form.name, label: form.label, columns: [] }),
        },
      );
      if (!res.ok) throw new Error(await res.text());
    },
    onSuccess: () => {
      setNewTableForm(null);
      queryClient.invalidateQueries({ queryKey: ["localdb", activeProjectPath, "tables"] });
    },
  });

  if (!activeProjectPath) {
    return (
      <div className="text-muted-foreground flex flex-1 items-center justify-center p-6 text-sm">
        No project selected. Open a project to manage its database.
      </div>
    );
  }

  return (
    <div className="flex h-full overflow-hidden">
      {/* Sidebar: table list */}
      <aside className="border-border flex w-48 shrink-0 flex-col overflow-hidden border-r">
        <div className="text-muted-foreground border-border flex items-center justify-between border-b px-3 py-2 text-[10px] font-semibold tracking-widest uppercase">
          TABLES
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            title="New table"
            onClick={() => setNewTableForm({ name: "", label: "" })}
          >
            <PlusIcon />
          </Button>
        </div>

        {newTableForm && (
          <form
            className="border-border flex flex-col gap-1.5 border-b bg-[var(--surface-0)] px-2 py-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (newTableForm.name && newTableForm.label) {
                createTableMutation.mutate(newTableForm);
              }
            }}
          >
            <Input
              placeholder="name (snake_case)"
              value={newTableForm.name}
              onChange={(e) => {
                const v = e.currentTarget.value;
                setNewTableForm((f) => f && { ...f, name: v });
              }}
              className="h-7 text-xs"
              autoFocus
            />
            <Input
              placeholder="label"
              value={newTableForm.label}
              onChange={(e) => {
                const v = e.currentTarget.value;
                setNewTableForm((f) => f && { ...f, label: v });
              }}
              className="h-7 text-xs"
            />
            <div className="flex gap-1.5">
              <Button
                type="submit"
                variant="default"
                size="xs"
                className="flex-1"
                disabled={createTableMutation.isPending}
              >
                Create
              </Button>
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() => setNewTableForm(null)}
              >
                Cancel
              </Button>
            </div>
          </form>
        )}

        <div className="flex-1 overflow-auto">
          {tablesQuery.isLoading && (
            <div className="text-muted-foreground px-3 py-2 text-xs">Loading…</div>
          )}
          {tablesQuery.data?.map((t) => (
            <TableListItem
              key={t.id}
              table={t}
              selected={selectedTable === t.name}
              onClick={() => {
                setSelectedTable(t.name);
                setView("data");
              }}
            />
          ))}
          {tablesQuery.data?.length === 0 && (
            <div className="text-muted-foreground px-3 py-3 text-xs">
              No tables yet. Click + to create one.
            </div>
          )}
        </div>
      </aside>

      {/* Main area */}
      <main className="flex flex-1 flex-col overflow-hidden">
        {selectedTable && schemaQuery.data ? (
          <>
            <div className="border-border flex shrink-0 items-center gap-2 border-b px-3 py-1.5">
              <span className="text-foreground text-xs font-semibold">
                {schemaQuery.data.table.label}
              </span>
              <span className="text-muted-foreground font-mono text-[10px]">
                {schemaQuery.data.table.name}
              </span>
              <div className="ml-auto flex gap-1">
                <button
                  type="button"
                  onClick={() => setView("data")}
                  className={`h-6 rounded px-2 text-[10px] font-medium transition-colors ${view === "data" ? "text-foreground bg-[var(--surface-0)]" : "text-muted-foreground hover:text-foreground"}`}
                >
                  Data
                </button>
                <button
                  type="button"
                  onClick={() => setView("schema")}
                  className={`h-6 rounded px-2 text-[10px] font-medium transition-colors ${view === "schema" ? "text-foreground bg-[var(--surface-0)]" : "text-muted-foreground hover:text-foreground"}`}
                >
                  Schema
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-auto p-3">
              {pendingPlan && (
                <div className="mb-4">
                  <MigrationReview
                    plan={pendingPlan}
                    onApply={async () => {
                      const { columnName, newDef } = pendingPlan;
                      const res = await fetch(
                        `/api/localdb/tables/${selectedTable}/columns/${columnName}/apply-migration?project=${encodeURIComponent(activeProjectPath)}`,
                        {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ newDef }),
                        },
                      );
                      if (!res.ok) {
                        console.error("Migration failed:", await res.text());
                        return;
                      }
                      setPendingPlan(null);
                      queryClient.invalidateQueries({
                        queryKey: ["localdb", activeProjectPath, "schema", selectedTable],
                      });
                    }}
                    onCancel={() => setPendingPlan(null)}
                  />
                </div>
              )}

              {view === "data" && (
                <DataTable
                  schema={schemaQuery.data}
                  adapter={adapter}
                  activeProjectPath={activeProjectPath}
                />
              )}

              {view === "schema" && (
                <SchemaBuilder
                  schema={schemaQuery.data}
                  adapter={adapter}
                  onSchemaChange={() => {
                    queryClient.invalidateQueries({
                      queryKey: ["localdb", activeProjectPath, "schema", selectedTable],
                    });
                  }}
                />
              )}
            </div>
          </>
        ) : (
          <div className="text-muted-foreground flex flex-1 items-center justify-center text-sm">
            {selectedTable ? "Loading schema…" : "Select a table to get started"}
          </div>
        )}
      </main>
    </div>
  );
}

function TableListItem({
  table,
  selected,
  onClick,
}: {
  table: TableMeta;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "w-full text-left px-3 py-2 flex flex-col border-l-2 transition-colors",
        selected
          ? "bg-primary/15 text-primary border-l-primary"
          : "hover:bg-muted text-foreground border-l-transparent",
      ].join(" ")}
    >
      <span className="text-xs leading-tight font-medium">{table.label}</span>
      <span className="text-muted-foreground font-mono text-[10px] leading-tight">
        {table.name}
      </span>
    </button>
  );
}
