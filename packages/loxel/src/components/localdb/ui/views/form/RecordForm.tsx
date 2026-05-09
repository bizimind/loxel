import type { TableSchema, FormViewDef, ValidationIssue } from "@bizimind/localdb-sdk";
import type React from "react";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";

import type { DataAdapter } from "../../adapters/data-adapter.ts";

import { FieldInput } from "../../fields/field-ui.tsx";
import { getField, defaultComponentKeyForColumn } from "../../fields/registry.ts";

interface Props {
  schema: TableSchema;
  viewDef?: FormViewDef;
  adapter: DataAdapter;
  initialValues?: Record<string, unknown>;
  /** Row id to update. Omit for insert. */
  rowId?: number;
  onSuccess?: (row: Record<string, unknown>) => void;
  onCancel?: () => void;
}

export function RecordForm({
  schema,
  viewDef,
  adapter,
  initialValues,
  rowId,
  onSuccess,
  onCancel,
}: Props) {
  const [values, setValues] = useState<Record<string, unknown>>(initialValues ?? {});
  const [issues, setIssues] = useState<Record<string, ValidationIssue[]>>({});
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const visibleCols = schema.columns.filter(
    (c) => c.def.kind !== "formula" && !viewDef?.hiddenColumns?.includes(c.name),
  );

  const orderedCols = viewDef?.fieldOrder
    ? [
        ...viewDef.fieldOrder
          .map((name) => visibleCols.find((c) => c.name === name))
          .filter(Boolean),
        ...visibleCols.filter((c) => !viewDef.fieldOrder!.includes(c.name)),
      ]
    : visibleCols;

  useEffect(() => {
    if (!successMessage) return;
    const timeout = window.setTimeout(() => setSuccessMessage(null), 2500);
    return () => window.clearTimeout(timeout);
  }, [successMessage]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setSuccessMessage(null);
    try {
      const result =
        rowId !== undefined
          ? await adapter.update(schema.table.name, rowId, values)
          : await adapter.insert(schema.table.name, values);

      if (result.ok) {
        setIssues({});
        if (rowId === undefined) {
          setValues(initialValues ?? {});
          setSuccessMessage("Created");
        } else {
          setSuccessMessage("Updated");
        }
        onSuccess?.(result.row as Record<string, unknown>);
      } else {
        const grouped: Record<string, ValidationIssue[]> = {};
        for (const issue of result.issues) {
          const key = issue.path[0] ?? "_";
          (grouped[key] ??= []).push(issue);
        }
        setSuccessMessage(null);
        setIssues(grouped);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="localdb-record-form flex flex-col gap-2.5 px-3 py-2.5">
      {orderedCols.map((col) => {
        const colName = col!.name;
        const isReadonly = viewDef?.readonlyColumns?.includes(colName);
        const componentKey = defaultComponentKeyForColumn(col!.def);
        const registered = componentKey ? getField(componentKey) : undefined;
        const EditComponent = registered?.Edit;
        const colIssues = issues[colName];

        return (
          <div key={colName}>
            <label
              htmlFor={`field-${colName}`}
              className="text-muted-foreground mb-1 block text-xs leading-none font-medium"
            >
              {col!.def.label}
              {"nullable" in col!.def && col!.def.nullable === false && (
                <span className="text-destructive ml-1">*</span>
              )}
            </label>
            <div>
              {EditComponent ? (
                <EditComponent
                  value={values[colName]}
                  schema={col!.def}
                  onChange={(v) => {
                    setSuccessMessage(null);
                    setValues((prev) => ({ ...prev, [colName]: v }));
                  }}
                  issues={colIssues}
                  disabled={submitting || isReadonly}
                />
              ) : (
                <FieldInput
                  id={`field-${colName}`}
                  type="text"
                  value={String(values[colName] ?? "")}
                  disabled={submitting || isReadonly}
                  onChange={(e) => {
                    setSuccessMessage(null);
                    setValues((prev) => ({ ...prev, [colName]: e.target.value || null }));
                  }}
                />
              )}
            </div>
          </div>
        );
      })}

      {issues["_"] && (
        <div className="text-destructive text-[0.8125rem]">
          {issues["_"]?.map((i, idx) => (
            <p key={idx}>{i.message}</p>
          ))}
        </div>
      )}

      <div className="flex items-center justify-end gap-1.5 pt-0.5">
        {successMessage && (
          <span
            role="status"
            aria-live="polite"
            className="text-muted-foreground text-xs leading-none"
          >
            {successMessage}
          </span>
        )}
        {onCancel && (
          <Button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            variant="outline"
            size="xs"
          >
            Cancel
          </Button>
        )}
        <Button type="submit" disabled={submitting} size="xs">
          {submitting ? "Saving…" : rowId !== undefined ? "Update" : "Create"}
        </Button>
      </div>
    </form>
  );
}
