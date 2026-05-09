import { Switch } from "@/components/ui/switch";

import type { FieldViewProps, FieldEditProps } from "../field-props.ts";

import { registerField } from "../registry.ts";

export function BooleanToggleView({ value }: FieldViewProps<boolean>) {
  return (
    <Switch
      checked={Boolean(value)}
      onCheckedChange={() => undefined}
      disabled
      className="pointer-events-none opacity-100"
    />
  );
}

export function BooleanToggle({ value, onChange, disabled }: FieldEditProps<boolean>) {
  return <Switch checked={value ?? false} onCheckedChange={onChange} disabled={disabled} />;
}

registerField({
  key: "boolean-toggle",
  label: "Toggle",
  compatibleKinds: ["boolean"],
  View: BooleanToggleView,
  Edit: BooleanToggle,
});
