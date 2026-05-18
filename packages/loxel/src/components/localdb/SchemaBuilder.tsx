import type { TableSchema, ColumnMeta, ColumnDef, OptionSet } from "@bizimind/localdb-sdk";
import { PencilIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import type { DataAdapter } from "@/components/localdb/ui";
import { Button } from "@/components/ui/button";
import { useQueryScope } from "@/queries/use-scope";

import { ColumnDefEditor } from "./ColumnDefEditor";

interface Props {
  schema: TableSchema;
  adapter: DataAdapter;
  onSchemaChange?: () => void;
}

export function SchemaBuilder({ schema, adapter: _adapter, onSchemaChange }: Props) {
  const { activeProjectPath } = useQueryScope();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingCol, setEditingCol] = useState<ColumnMeta | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  async function handleSave(def: ColumnDef) {
    setSaving(true);
    setSaveError(null);
    try {
      const project = encodeURIComponent(activeProjectPath ?? "");
      if (editingCol) {
        const res = await fetch(
          `/api/localdb/tables/${schema.table.name}/columns/${editingCol.name}/apply-migration?project=${project}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ newDef: def }),
          },
        );
        if (!res.ok) throw new Error(await res.text());
      } else {
        const res = await fetch(
          `/api/localdb/tables/${schema.table.name}/columns?project=${project}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(def),
          },
        );
        if (!res.ok) throw new Error(await res.text());
      }
      setDialogOpen(false);
      onSchemaChange?.();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {/* Column list */}
      <div className="border-border/60 overflow-hidden rounded border">
        {schema.columns.map((col) => (
          <div
            key={col.id}
            className="group border-border/40 hover:bg-muted/50 flex items-center gap-2 border-b px-3 py-2 transition-colors last:border-b-0"
          >
            <span className="text-muted-foreground font-mono text-xs">{col.name}</span>
            <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-[10px] font-medium">
              {col.def.kind}
            </span>
            <span className="text-foreground text-xs">{col.def.label}</span>
            <span className="text-muted-foreground ml-auto text-[10px]">
              {constraintSummary(col.def)}
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              className="opacity-0 group-hover:opacity-100"
              onClick={() => {
                setEditingCol(col);
                setDialogOpen(true);
              }}
            >
              <PencilIcon className="size-3" />
            </Button>
          </div>
        ))}
        {schema.columns.length === 0 && (
          <div className="text-muted-foreground px-3 py-6 text-center text-xs">No columns yet</div>
        )}
      </div>

      <Button
        variant="outline"
        size="xs"
        className="w-full"
        onClick={() => {
          setEditingCol(null);
          setDialogOpen(true);
        }}
      >
        <PlusIcon /> Add Column
      </Button>

      {saveError && <p className="text-destructive text-xs">{saveError}</p>}

      <ColumnDefEditor
        open={dialogOpen}
        initial={editingCol?.def}
        onSave={handleSave}
        saving={saving}
        onCancel={() => setDialogOpen(false)}
      />
    </div>
  );
}

function constraintSummary(def: ColumnDef): string {
  const parts: string[] = [];
  if ("nullable" in def && def.nullable === false) parts.push("required");
  if ("unique" in def && (def as { unique?: boolean }).unique) parts.push("unique");
  if ("multi" in def && (def as { multi?: boolean }).multi) parts.push("multi");
  if ("min" in def && (def as { min?: number }).min !== undefined)
    parts.push(`min=${(def as { min?: number }).min}`);
  if ("max" in def && (def as { max?: number }).max !== undefined)
    parts.push(`max=${(def as { max?: number }).max}`);
  if ("integer" in def && (def as { integer?: boolean }).integer) parts.push("integer");
  if ("maxLength" in def && (def as { maxLength?: number }).maxLength !== undefined)
    parts.push(`maxLen=${(def as { maxLength?: number }).maxLength}`);
  if ("options" in def && (def as { options?: OptionSet }).options !== undefined) {
    const opts = (def as { options: OptionSet }).options;
    parts.push(opts.source === "inline" ? `options(${opts.items.length})` : `ref:${opts.table}`);
  }
  if (def.kind === "formula") parts.push(`expr: ${def.expression}`);
  return parts.join(", ") || "—";
}
