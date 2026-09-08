import type { FieldViewProps, FieldEditProps } from "../field-props.ts";
import { EmptyValue, FieldError, FieldInput } from "../field-ui.tsx";
import { issueMessage } from "../issue-message.ts";
import { registerField } from "../registry.ts";

export function TextView({ value }: FieldViewProps<string>) {
  if (!value) return <EmptyValue />;
  return <span>{value}</span>;
}

export function TextInput({ value, onChange, issues, disabled, schema }: FieldEditProps<string>) {
  const error = issueMessage(issues);
  const maxLength = "maxLength" in schema ? (schema.maxLength as number | undefined) : undefined;
  return (
    <div>
      <FieldInput
        type="text"
        value={value ?? ""}
        maxLength={maxLength}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value || null)}
        aria-invalid={!!error}
      />
      <FieldError message={error} />
    </div>
  );
}

registerField({
  key: "text-input",
  label: "Text",
  compatibleKinds: ["text"],
  View: TextView,
  Edit: TextInput,
});
