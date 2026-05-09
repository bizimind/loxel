import type { FieldViewProps, FieldEditProps } from "../field-props.ts";

import { EmptyValue } from "../field-ui.tsx";
import { registerField } from "../registry.ts";

export function BooleanView({ value }: FieldViewProps<boolean>) {
  return value ? <span aria-label="checked">✓</span> : <EmptyValue />;
}

export function BooleanCheckbox({ value, onChange, disabled }: FieldEditProps<boolean>) {
  return (
    <input
      type="checkbox"
      checked={value ?? false}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
      className="accent-primary size-3.5 rounded"
    />
  );
}

registerField({
  key: "boolean-checkbox",
  label: "Checkbox",
  compatibleKinds: ["boolean"],
  View: BooleanView,
  Edit: BooleanCheckbox,
});
