import type { InlineOption } from "@bizimind/localdb-sdk";

import { Badge } from "@/components/ui/badge";

import type { FieldViewProps, FieldEditProps } from "../field-props.ts";

import { EmptyValue, FieldError, FieldSelect } from "../field-ui.tsx";
import { issueMessage } from "../issue-message.ts";
import { registerField } from "../registry.ts";

// Value is an InlineOption object (hydrated by SDK)
export function SingleSelectView({ value }: FieldViewProps<InlineOption>) {
  if (!value) return <EmptyValue />;
  return <OptionBadge option={value} />;
}

// Edit: receives options from schema.options.items (ColumnDef), submits value (string|number)
export function SingleSelectCombobox({
  value,
  schema,
  onChange,
  issues,
  disabled,
}: FieldEditProps<string | number>) {
  const def = schema as { options?: { source: "inline"; items: InlineOption[] } };
  const items = def.options?.source === "inline" ? def.options.items : [];
  const error = issueMessage(issues);
  // value here might be an InlineOption (from hydration) or a raw value
  const currentValue =
    typeof value === "object" && value !== null ? (value as InlineOption).value : value;
  return (
    <div>
      <FieldSelect
        value={String(currentValue ?? "")}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value || null)}
      >
        <option value="">—</option>
        {items.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </FieldSelect>
      <FieldError message={error} />
    </div>
  );
}

registerField({
  key: "single-select",
  label: "Dropdown",
  compatibleKinds: ["text", "number"],
  View: SingleSelectView,
  Edit: SingleSelectCombobox,
});

function OptionBadge({ option }: { option: InlineOption }) {
  return (
    <Badge
      variant="outline"
      className="h-6 px-2.5 py-0.5 text-[0.85em]"
      style={option.color ? { borderColor: option.color } : undefined}
    >
      {option.label}
    </Badge>
  );
}
