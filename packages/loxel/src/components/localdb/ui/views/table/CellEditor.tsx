import type { ColumnDef, ValidationIssue } from "@bizimind/localdb-sdk";
import type React from "react";

import { cn } from "@/lib/utils";

import type { ComponentKey } from "../../fields/field-props.ts";

import { FieldInput, FieldSelect, FieldTextarea } from "../../fields/field-ui.tsx";
import { issueMessage } from "../../fields/issue-message.ts";
import { getField, defaultComponentKeyForColumn } from "../../fields/registry.ts";

interface Props {
  def: ColumnDef;
  /** Override from viewDef.columnComponents — uses default if omitted */
  componentKey?: ComponentKey;
  value: unknown;
  onChange: (v: unknown) => void;
  onCommit: () => void;
  onCancel: () => void;
  issues?: ValidationIssue[];
  autoFocus?: boolean;
}

const editorClassName = "border-primary bg-[var(--surface-0)] text-xs";

export function CellEditor({
  def,
  componentKey,
  value,
  onChange,
  onCommit,
  onCancel,
  issues,
  autoFocus,
}: Props) {
  // Try registered Edit component first (respects user-configured componentKey)
  const key = componentKey ?? defaultComponentKeyForColumn(def);
  const registered = key ? getField(key) : undefined;
  if (registered?.Edit) {
    const EditComponent = registered.Edit;
    return (
      <div
        className="outline-primary rounded-sm outline-1"
        onKeyDown={(e) => {
          if (e.key === "Enter" && def.kind !== "longtext") {
            e.preventDefault();
            onCommit();
          }
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
      >
        <EditComponent value={value} schema={def} onChange={onChange} />
        <CellIssue issues={issues} />
      </div>
    );
  }

  // Native fallback — type-aware
  function keyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && def.kind !== "longtext") {
      e.preventDefault();
      onCommit();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  }

  if (def.kind === "boolean") {
    return (
      <input
        type="checkbox"
        checked={Boolean(value)}
        onChange={(e) => onChange(e.target.checked)}
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus={autoFocus}
        className="accent-primary size-4 cursor-pointer"
      />
    );
  }

  if (def.kind === "number" && !def.multi) {
    // options-constrained number → select
    if (def.options?.source === "inline") {
      return (
        <FieldSelect
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={keyDown}
          className={editorClassName}
          autoFocus={autoFocus}
        >
          <option value="">—</option>
          {def.options.items.map((o) => (
            <option key={String(o.value)} value={String(o.value)}>
              {o.label}
            </option>
          ))}
        </FieldSelect>
      );
    }
    return (
      <FieldInput
        type="number"
        value={String(value ?? "")}
        onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
        onKeyDown={keyDown}
        className={editorClassName}
        autoFocus={autoFocus}
        {...(def.min !== undefined ? { min: def.min } : {})}
        {...(def.max !== undefined ? { max: def.max } : {})}
        step={def.integer ? 1 : "any"}
      />
    );
  }

  if (def.kind === "text" && !def.multi) {
    // options-constrained text → select
    if (def.options?.source === "inline") {
      return (
        <FieldSelect
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value || null)}
          onKeyDown={keyDown}
          className={editorClassName}
          autoFocus={autoFocus}
        >
          <option value="">—</option>
          {def.options.items.map((o) => (
            <option key={String(o.value)} value={String(o.value)}>
              {o.label}
            </option>
          ))}
        </FieldSelect>
      );
    }
    return (
      <FieldInput
        type="text"
        value={String(value ?? "")}
        onChange={(e) => onChange(e.target.value || null)}
        onKeyDown={keyDown}
        className={editorClassName}
        autoFocus={autoFocus}
        {...(def.maxLength ? { maxLength: def.maxLength } : {})}
      />
    );
  }

  if (def.kind === "longtext") {
    return (
      <FieldTextarea
        value={String(value ?? "")}
        onChange={(e) => onChange(e.target.value || null)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        className={cn(editorClassName, "min-h-14")}
        autoFocus={autoFocus}
      />
    );
  }

  if (def.kind === "color") {
    return (
      <div className="flex items-center gap-1">
        <input
          type="color"
          value={String(value || "#000000")}
          onChange={(e) => onChange(e.target.value)}
          className="size-7 cursor-pointer rounded border-0 p-0"
        />
        <FieldInput
          type="text"
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value || null)}
          onKeyDown={keyDown}
          className={cn(editorClassName, "flex-1")}
          placeholder="#hex"
        />
      </div>
    );
  }

  if (def.kind === "url") {
    return (
      <FieldInput
        type="url"
        value={String(value ?? "")}
        onChange={(e) => onChange(e.target.value || null)}
        onKeyDown={keyDown}
        className={editorClassName}
        autoFocus={autoFocus}
        placeholder="https://"
      />
    );
  }

  if (def.kind === "date") {
    return (
      <FieldInput
        type="date"
        value={String(value ?? "")}
        onChange={(e) => onChange(e.target.value || null)}
        onKeyDown={keyDown}
        className={editorClassName}
        autoFocus={autoFocus}
      />
    );
  }

  if (def.kind === "datetime") {
    return (
      <FieldInput
        type="datetime-local"
        value={String(value ?? "").slice(0, 16)}
        onChange={(e) => onChange(e.target.value || null)}
        onKeyDown={keyDown}
        className={editorClassName}
        autoFocus={autoFocus}
      />
    );
  }

  if (def.kind === "duration") {
    const totalSeconds = typeof value === "number" ? value : 0;
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const updateDuration = (h: number, m: number) => onChange(h * 3600 + m * 60);
    return (
      <div className="flex items-center gap-1" onKeyDown={keyDown}>
        <FieldInput
          type="number"
          value={hours}
          min={0}
          step={1}
          onChange={(e) => updateDuration(Math.max(0, parseInt(e.target.value, 10) || 0), minutes)}
          className={cn(editorClassName, "w-12")}
          autoFocus={autoFocus}
          aria-label="hours"
        />
        <span className="text-xs leading-none">h</span>
        <FieldInput
          type="number"
          value={minutes}
          min={0}
          max={59}
          step={1}
          onChange={(e) => updateDuration(hours, Math.max(0, parseInt(e.target.value, 10) || 0))}
          className={cn(editorClassName, "w-12")}
          aria-label="minutes"
        />
        <span className="text-xs leading-none">m</span>
      </div>
    );
  }

  // multi (tags / multi-select without registered component) — comma-separated display
  if ("multi" in def && def.multi) {
    const arr = Array.isArray(value) ? value : [];
    return (
      <FieldInput
        type="text"
        value={arr.join(", ")}
        onChange={(e) =>
          onChange(
            e.target.value
              ? e.target.value
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean)
              : [],
          )
        }
        onKeyDown={keyDown}
        className={editorClassName}
        autoFocus={autoFocus}
        placeholder="comma-separated"
      />
    );
  }

  return (
    <FieldInput
      type="text"
      value={String(value ?? "")}
      onChange={(e) => onChange(e.target.value || null)}
      onKeyDown={keyDown}
      className={editorClassName}
      autoFocus={autoFocus}
    />
  );
}

function CellIssue({ issues }: { issues?: ValidationIssue[] }) {
  const message = issueMessage(issues);
  if (!message) return null;
  return <div className="text-destructive px-1.5 py-1 text-[0.72rem]">{message}</div>;
}
