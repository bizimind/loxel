import type { FieldViewProps, FieldEditProps } from "../field-props.ts";
import { EmptyValue, FieldError, FieldInput } from "../field-ui.tsx";
import { issueMessage } from "../issue-message.ts";
import { registerField } from "../registry.ts";

type NumberDef = { kind: "number"; min?: number; max?: number; integer?: boolean };

export function NumberView({ value }: FieldViewProps<number>) {
  if (value === null || value === undefined) return <EmptyValue />;
  return <span>{value}</span>;
}

export function NumberInput({ value, schema, onChange, issues, disabled }: FieldEditProps<number>) {
  const def = schema as NumberDef;
  const error = issueMessage(issues);
  return (
    <div>
      <FieldInput
        type="number"
        value={value ?? ""}
        min={def.min}
        max={def.max}
        step={def.integer ? 1 : "any"}
        disabled={disabled}
        onChange={(e) => {
          const raw = e.target.value;
          onChange(raw === "" ? null : Number(raw));
        }}
        aria-invalid={!!error}
      />
      <FieldError message={error} />
    </div>
  );
}

registerField({
  key: "number-input",
  label: "Number",
  compatibleKinds: ["number"],
  View: NumberView,
  Edit: NumberInput,
});
