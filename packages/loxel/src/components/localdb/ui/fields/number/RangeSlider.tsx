import type React from "react";

import { cn } from "@/lib/utils";

import type { FieldViewProps, FieldEditProps } from "../field-props.ts";

type NumberDef = { kind: "number"; min?: number; max?: number; integer?: boolean };

export function RangeSliderView({ value, schema }: FieldViewProps<number>) {
  const def = schema as NumberDef;
  const min = def.min ?? 0;
  const max = def.max ?? 100;
  const pct = value !== null && value !== undefined ? ((value - min) / (max - min)) * 100 : 0;
  return (
    <div className="flex items-center gap-2">
      <div
        className="bg-muted h-1 flex-1 rounded-sm"
        style={{
          background: `linear-gradient(to right, var(--primary) ${pct}%, var(--muted) ${pct}%)`,
        }}
      />
      <RangeValue>{value ?? "-"}</RangeValue>
    </div>
  );
}

export function RangeSlider({ value, schema, onChange, disabled }: FieldEditProps<number>) {
  const def = schema as NumberDef;
  const min = def.min ?? 0;
  const max = def.max ?? 100;
  const step = def.integer ? 1 : 0.01;
  return (
    <div className="flex items-center gap-2">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value ?? min}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="accent-primary flex-1"
      />
      <RangeValue>{value ?? min}</RangeValue>
    </div>
  );
}

function RangeValue({ children, className }: React.ComponentProps<"span">) {
  return <span className={cn("min-w-7 text-right text-xs", className)}>{children}</span>;
}
