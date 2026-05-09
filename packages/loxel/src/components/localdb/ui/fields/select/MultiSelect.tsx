import type { InlineOption } from "@bizimind/localdb-sdk";

import { Badge } from "@/components/ui/badge";

import type { FieldViewProps, FieldEditProps } from "../field-props.ts";

import { EmptyValue, FieldError } from "../field-ui.tsx";
import { issueMessage } from "../issue-message.ts";
import { registerField } from "../registry.ts";

// Value is InlineOption[] (hydrated) for view
export function MultiSelectView({ value }: FieldViewProps<InlineOption[]>) {
  const values = value ?? [];
  if (values.length === 0) return <EmptyValue />;
  return (
    <span className="flex flex-wrap gap-1">
      {values.map((opt) => (
        <OptionBadge key={String(opt.value)} option={opt} />
      ))}
    </span>
  );
}

// Edit: receives array of values (string|number), submits array of values
export function MultiSelectCheckboxes({
  value,
  schema,
  onChange,
  issues,
  disabled,
}: FieldEditProps<(string | number)[]>) {
  const def = schema as { options?: { source: "inline"; items: InlineOption[] } };
  const items = def.options?.source === "inline" ? def.options.items : [];

  // value may be InlineOption[] (hydrated) or raw value[]
  const rawValues: (string | number)[] = (value ?? []).map((v) => {
    if (typeof v === "object" && v !== null && "value" in v) {
      return (v as InlineOption).value;
    }
    return v as string | number;
  });

  const selected = new Set(rawValues.map(String));
  const error = issueMessage(issues);

  function toggle(optValue: string | number) {
    const key = String(optValue);
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    // Return values matching original type from items
    const result = items.filter((o) => next.has(String(o.value))).map((o) => o.value);
    onChange(result.length > 0 ? result : null);
  }

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {items.map((opt) => (
          <label
            key={String(opt.value)}
            className="flex cursor-pointer items-center gap-1.5 text-xs has-disabled:cursor-not-allowed has-disabled:opacity-50"
          >
            <input
              type="checkbox"
              checked={selected.has(String(opt.value))}
              disabled={disabled}
              onChange={() => toggle(opt.value)}
              className="accent-primary size-3.5 rounded"
            />
            {opt.label}
          </label>
        ))}
      </div>
      <FieldError message={error} />
    </div>
  );
}

registerField({
  key: "multi-select-checkboxes",
  label: "Checkboxes",
  compatibleKinds: ["text", "number"],
  View: MultiSelectView,
  Edit: MultiSelectCheckboxes,
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
