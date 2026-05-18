import type { FieldViewProps, FieldEditProps } from "../field-props.ts";
import { EmptyValue, FieldInput } from "../field-ui.tsx";
import { registerField } from "../registry.ts";

export function ColorView({ value }: FieldViewProps<string>) {
  if (!value) return <EmptyValue />;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className="border-border inline-block size-4 rounded-sm border"
        style={{ background: value }}
      />
      <code className="text-[0.85em]">{value}</code>
    </span>
  );
}

export function ColorPicker({ value, onChange, disabled }: FieldEditProps<string>) {
  return (
    <div className="flex items-center gap-2">
      <input
        type="color"
        value={value ?? "#000000"}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 w-9 cursor-pointer rounded p-0.5 disabled:cursor-not-allowed disabled:opacity-50"
      />
      <FieldInput
        type="text"
        value={value ?? ""}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value || null)}
        placeholder="#000000"
        maxLength={7}
        className="w-24 font-mono"
      />
    </div>
  );
}

registerField({
  key: "color-picker",
  label: "Color",
  compatibleKinds: ["color"],
  View: ColorView,
  Edit: ColorPicker,
});
