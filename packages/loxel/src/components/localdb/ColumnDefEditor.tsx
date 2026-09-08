import type { ColumnDef, InlineOption } from "@bizimind/localdb-sdk";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { DialogShell } from "@/components/ui/dialog-shell";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

interface Props {
  open: boolean;
  initial?: Partial<ColumnDef>;
  onSave: (def: ColumnDef) => void;
  onCancel: () => void;
  saving?: boolean;
}

const KINDS: ColumnDef["kind"][] = [
  "text",
  "longtext",
  "number",
  "boolean",
  "date",
  "datetime",
  "duration",
  "color",
  "url",
  "formula",
  "ref",
];

const MULTI_CAPABLE_KINDS: ColumnDef["kind"][] = ["text", "url", "color", "number"];
const OPTIONS_CAPABLE_KINDS: ColumnDef["kind"][] = ["text", "number"];

export function ColumnDefEditor({ open, initial, onSave, onCancel, saving }: Props) {
  const [label, setLabel] = useState(initial?.label ?? "");
  const [kind, setKind] = useState<ColumnDef["kind"]>(initial?.kind ?? "text");
  const [nullable, setNullable] = useState(
    "nullable" in (initial ?? {}) ? ((initial as { nullable?: boolean }).nullable ?? true) : true,
  );

  // Kind-specific state
  const [min, setMin] = useState<string>("");
  const [max, setMax] = useState<string>("");
  const [integer, setInteger] = useState(false);
  const [maxLength, setMaxLength] = useState<string>("");
  const [unique, setUnique] = useState(false);
  const [multi, setMulti] = useState(false);
  const [hasOptions, setHasOptions] = useState(false);
  const [optionItems, setOptionItems] = useState<InlineOption[]>([]);
  const [newOptionValue, setNewOptionValue] = useState("");
  const [newOptionLabel, setNewOptionLabel] = useState("");
  const [expression, setExpression] = useState("");
  const [resultKind, setResultKind] = useState<"number" | "text" | "boolean">("number");

  function buildDef(): ColumnDef {
    const base = { label, nullable };
    const inlineOptions =
      hasOptions && OPTIONS_CAPABLE_KINDS.includes(kind)
        ? { options: { source: "inline" as const, items: optionItems } }
        : {};
    const multiFlag = multi && MULTI_CAPABLE_KINDS.includes(kind) ? { multi: true as const } : {};

    switch (kind) {
      case "boolean":
        return { ...base, kind: "boolean" };
      case "date":
        return { ...base, kind: "date" };
      case "datetime":
        return { ...base, kind: "datetime" };
      case "duration":
        return { ...base, kind: "duration" };
      case "number":
        return {
          ...base,
          kind: "number",
          ...(min !== "" ? { min: Number(min) } : {}),
          ...(max !== "" ? { max: Number(max) } : {}),
          ...(integer ? { integer: true } : {}),
          ...(unique && !multi ? { unique: true } : {}),
          ...multiFlag,
          ...inlineOptions,
        };
      case "text":
        return {
          ...base,
          kind: "text",
          ...(maxLength !== "" ? { maxLength: Number(maxLength) } : {}),
          ...(unique && !multi ? { unique: true } : {}),
          ...multiFlag,
          ...inlineOptions,
        };
      case "longtext":
        return { ...base, kind: "longtext" };
      case "color":
        return { ...base, kind: "color", ...multiFlag };
      case "url":
        return {
          ...base,
          kind: "url",
          ...(unique && !multi ? { unique: true } : {}),
          ...multiFlag,
        };
      case "formula":
        return { label, kind: "formula", expression, resultKind };
      case "ref":
        return { ...base, kind: "ref", targetTable: "", targetColumn: "" };
      default: {
        const _exhaustive: never = kind;
        throw new Error(`Unknown column kind: ${String(_exhaustive)}`);
      }
    }
  }

  function addOption() {
    const val = newOptionValue.trim();
    const lbl = newOptionLabel.trim() || val;
    if (!val) return;
    setOptionItems((prev) => [...prev, { value: val, label: lbl, position: prev.length }]);
    setNewOptionValue("");
    setNewOptionLabel("");
  }

  const isAdd = !initial?.kind;
  const showMulti = MULTI_CAPABLE_KINDS.includes(kind);
  const showOptions = OPTIONS_CAPABLE_KINDS.includes(kind);

  return (
    <DialogShell open={open} onCancel={onCancel} className="w-[420px]">
      {/* Header */}
      <div className="border-border flex items-center justify-between border-b px-4 py-3">
        <h2 className="text-foreground text-sm font-semibold">
          {isAdd ? "Add Column" : "Edit Column"}
        </h2>
      </div>

      {/* Body */}
      <form className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto p-4">
        {/* Label */}
        <div className="flex flex-col gap-1.5">
          <label className="text-muted-foreground text-xs font-medium">Label</label>
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Column label"
            autoFocus
          />
        </div>

        {/* Type */}
        <div className="flex flex-col gap-1.5">
          <label className="text-muted-foreground text-xs font-medium">Type</label>
          <select
            value={kind}
            onChange={(e) => {
              const newKind = e.target.value as ColumnDef["kind"];
              setKind(newKind);
              if (!MULTI_CAPABLE_KINDS.includes(newKind)) setMulti(false);
              if (!OPTIONS_CAPABLE_KINDS.includes(newKind)) setHasOptions(false);
            }}
            className="border-input text-foreground focus-visible:ring-ring h-9 w-full rounded-md border bg-[var(--surface-2)] px-3 py-1 text-sm focus-visible:ring-1 focus-visible:outline-none"
          >
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </div>

        {/* Nullable */}
        {kind !== "formula" && (
          <div className="flex items-center justify-between">
            <label className="text-foreground text-sm">Nullable (optional)</label>
            <Switch checked={nullable} onCheckedChange={setNullable} />
          </div>
        )}

        {/* Multi */}
        {showMulti && (
          <div className="flex items-center justify-between">
            <label className="text-foreground text-sm">Multi (array)</label>
            <Switch checked={multi} onCheckedChange={setMulti} />
          </div>
        )}

        {/* Options toggle */}
        {showOptions && (
          <div className="flex items-center justify-between">
            <label className="text-foreground text-sm">Constrained options</label>
            <Switch checked={hasOptions} onCheckedChange={setHasOptions} />
          </div>
        )}

        {/* Inline options editor */}
        {showOptions && hasOptions && (
          <div className="flex flex-col gap-2">
            <label className="text-muted-foreground text-xs font-medium">Options</label>
            {optionItems.length > 0 && (
              <div className="border-border overflow-hidden rounded-md border">
                {optionItems.map((o, i) => (
                  <div
                    key={i}
                    className="border-border/50 flex items-center justify-between border-b bg-[var(--surface-2)] px-3 py-1.5 last:border-b-0"
                  >
                    <span className="text-muted-foreground font-mono text-xs">
                      {String(o.value)}
                    </span>
                    <span className="text-foreground text-xs">{o.label}</span>
                    <button
                      type="button"
                      onClick={() => setOptionItems(optionItems.filter((_, j) => j !== i))}
                      className="text-muted-foreground hover:text-foreground text-sm leading-none"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex gap-2">
              <Input
                value={newOptionValue}
                onChange={(e) => setNewOptionValue(e.target.value)}
                placeholder="Value (e.g. open)"
                className="flex-1"
              />
              <Input
                value={newOptionLabel}
                onChange={(e) => setNewOptionLabel(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addOption())}
                placeholder="Label (e.g. Open)"
                className="flex-1"
              />
              <Button type="button" variant="outline" size="sm" onClick={addOption}>
                Add
              </Button>
            </div>
          </div>
        )}

        {/* Number-specific */}
        {kind === "number" && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <label className="text-muted-foreground text-xs font-medium">Min</label>
                <Input
                  type="number"
                  value={min}
                  onChange={(e) => setMin(e.target.value)}
                  placeholder="—"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-muted-foreground text-xs font-medium">Max</label>
                <Input
                  type="number"
                  value={max}
                  onChange={(e) => setMax(e.target.value)}
                  placeholder="—"
                />
              </div>
            </div>
            <div className="flex items-center justify-between">
              <label className="text-foreground text-sm">Integer only</label>
              <Switch checked={integer} onCheckedChange={setInteger} />
            </div>
          </>
        )}

        {/* Text-specific */}
        {kind === "text" && (
          <>
            <div className="flex flex-col gap-1.5">
              <label className="text-muted-foreground text-xs font-medium">Max Length</label>
              <Input
                type="number"
                value={maxLength}
                onChange={(e) => setMaxLength(e.target.value)}
                placeholder="No limit"
              />
            </div>
            {!multi && (
              <div className="flex items-center justify-between">
                <label className="text-foreground text-sm">Unique</label>
                <Switch checked={unique} onCheckedChange={setUnique} />
              </div>
            )}
          </>
        )}

        {/* Formula */}
        {kind === "formula" && (
          <>
            <div className="flex flex-col gap-1.5">
              <label className="text-muted-foreground text-xs font-medium">Expression</label>
              <Input
                value={expression}
                onChange={(e) => setExpression(e.target.value)}
                placeholder="e.g. price * qty"
                className="font-mono"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-muted-foreground text-xs font-medium">Result type</label>
              <select
                value={resultKind}
                onChange={(e) => setResultKind(e.target.value as "number" | "text" | "boolean")}
                className="border-input text-foreground focus-visible:ring-ring h-9 w-full rounded-md border bg-[var(--surface-2)] px-3 py-1 text-sm focus-visible:ring-1 focus-visible:outline-none"
              >
                <option value="number">number</option>
                <option value="text">text</option>
                <option value="boolean">boolean</option>
              </select>
            </div>
          </>
        )}
      </form>

      {/* Footer */}
      <div className="border-border flex justify-end gap-2 border-t px-4 py-3">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="default"
          onClick={() => label && onSave(buildDef())}
          disabled={!label || saving}
        >
          Save
        </Button>
      </div>
    </DialogShell>
  );
}
