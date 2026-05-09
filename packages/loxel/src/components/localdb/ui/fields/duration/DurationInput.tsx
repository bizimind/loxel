import type { FieldViewProps, FieldEditProps } from "../field-props.ts";

import { EmptyValue, FieldInput } from "../field-ui.tsx";
import { registerField } from "../registry.ts";

function formatDuration(seconds: number): string {
  if (seconds === 0) return "0m";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  return parts.join(" ");
}

export function DurationView({ value }: FieldViewProps<unknown>) {
  if (value === null || value === undefined) return <EmptyValue />;
  return <span>{formatDuration(typeof value === "number" ? value : 0)}</span>;
}

export function DurationEdit({ value, onChange, disabled }: FieldEditProps<unknown>) {
  const totalSeconds = typeof value === "number" ? value : 0;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  function update(h: number, m: number) {
    onChange(h * 3600 + m * 60);
  }

  return (
    <div className="flex items-center gap-1">
      <FieldInput
        type="number"
        value={hours}
        min={0}
        step={1}
        disabled={disabled}
        onChange={(e) => update(Math.max(0, parseInt(e.target.value, 10) || 0), minutes)}
        className="w-12"
        aria-label="hours"
      />
      <span className="text-muted-foreground text-xs leading-none">h</span>
      <FieldInput
        type="number"
        value={minutes}
        min={0}
        max={59}
        step={1}
        disabled={disabled}
        onChange={(e) => update(hours, Math.max(0, parseInt(e.target.value, 10) || 0))}
        className="w-12"
        aria-label="minutes"
      />
      <span className="text-muted-foreground text-xs leading-none">m</span>
    </div>
  );
}

registerField({
  key: "duration-input",
  label: "Duration (h/m)",
  compatibleKinds: ["duration"],
  View: DurationView,
  Edit: DurationEdit,
});
