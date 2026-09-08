import { dayjs } from "@/lib/dayjs";

import type { FieldViewProps, FieldEditProps } from "../field-props.ts";
import { EmptyValue, FieldInput } from "../field-ui.tsx";
import { registerField } from "../registry.ts";

export function DateTimeView({ value }: FieldViewProps<unknown>) {
  if (value === null || value === undefined) return <EmptyValue />;
  const parsed = dayjs(String(value));
  if (!parsed.isValid()) return <span>{String(value)}</span>;
  return <span title={parsed.format("YYYY-MM-DD HH:mm:ss")}>{parsed.fromNow()}</span>;
}

export function DateTimeEdit({ value, onChange, disabled }: FieldEditProps<unknown>) {
  const strVal = typeof value === "string" ? value.slice(0, 16) : "";
  return (
    <FieldInput
      type="datetime-local"
      value={strVal}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value || null)}
    />
  );
}

registerField({
  key: "datetime-input",
  label: "Date & Time Picker",
  compatibleKinds: ["datetime"],
  View: DateTimeView,
  Edit: DateTimeEdit,
});
