import type { FieldViewProps, FieldEditProps } from "../field-props.ts";
import { EmptyValue, FieldError, FieldTextarea } from "../field-ui.tsx";
import { issueMessage } from "../issue-message.ts";
import { registerField } from "../registry.ts";

export function LongTextView({ value }: FieldViewProps<string>) {
  if (!value) return <EmptyValue />;
  return <span className="whitespace-pre-wrap">{value}</span>;
}

export function LongTextTextarea({ value, onChange, issues, disabled }: FieldEditProps<string>) {
  const error = issueMessage(issues);
  return (
    <div>
      <FieldTextarea
        value={value ?? ""}
        disabled={disabled}
        rows={4}
        onChange={(e) => onChange(e.target.value || null)}
        aria-invalid={!!error}
      />
      <FieldError message={error} />
    </div>
  );
}

registerField({
  key: "longtext-textarea",
  label: "Textarea",
  compatibleKinds: ["longtext"],
  View: LongTextView,
  Edit: LongTextTextarea,
});
