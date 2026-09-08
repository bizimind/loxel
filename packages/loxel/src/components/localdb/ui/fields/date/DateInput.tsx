import { dayjs } from "@/lib/dayjs";

import type { FieldViewProps, FieldEditProps } from "../field-props.ts";
import { EmptyValue, FieldInput } from "../field-ui.tsx";
import { registerField } from "../registry.ts";

export function DateView({ value }: FieldViewProps<unknown>) {
  if (value === null || value === undefined) return <EmptyValue />;
  const parsed = dayjs(String(value));
  if (!parsed.isValid()) return <span>{String(value)}</span>;
  return <span title={parsed.format("YYYY-MM-DD")}>{parsed.fromNow()}</span>;
}

export function DateEdit({ value, onChange, disabled }: FieldEditProps<unknown>) {
  return (
    <FieldInput
      type="date"
      value={typeof value === "string" ? value : ""}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value || null)}
    />
  );
}

registerField({
  key: "date-input",
  label: "Date Picker",
  compatibleKinds: ["date"],
  View: DateView,
  Edit: DateEdit,
});
