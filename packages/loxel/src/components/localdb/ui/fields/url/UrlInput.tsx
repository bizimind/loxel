import type { FieldViewProps, FieldEditProps } from "../field-props.ts";
import { EmptyValue, FieldError, FieldInput } from "../field-ui.tsx";
import { issueMessage } from "../issue-message.ts";
import { registerField } from "../registry.ts";

export function UrlView({ value }: FieldViewProps<string>) {
  if (!value) return <EmptyValue />;
  return (
    <a href={value} target="_blank" rel="noopener noreferrer" className="text-primary underline">
      {value}
    </a>
  );
}

export function UrlInput({ value, onChange, issues, disabled }: FieldEditProps<string>) {
  const error = issueMessage(issues);
  return (
    <div>
      <FieldInput
        type="url"
        value={value ?? ""}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value || null)}
        aria-invalid={!!error}
        placeholder="https://"
      />
      <FieldError message={error} />
    </div>
  );
}

registerField({
  key: "url-input",
  label: "URL",
  compatibleKinds: ["url"],
  View: UrlView,
  Edit: UrlInput,
});
