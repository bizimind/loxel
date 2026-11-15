import type { FieldViewProps, FieldEditProps } from "../field-props.ts";
import { registerField } from "../registry.ts";

export function BooleanView({ value }: FieldViewProps<boolean>) {
  // Light: heavier marks so true and false read at a glance.
  if (value) {
    return (
      <span aria-label="checked" className="font-semibold dark:font-normal">
        ✓
      </span>
    );
  }
  return (
    <span className="text-foreground/70 dark:text-muted-foreground font-semibold dark:font-normal">
      -
    </span>
  );
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
