import type { FormulaColumnDef } from "@bizimind/localdb-sdk";

import type { FieldViewProps } from "../field-props.ts";

import { EmptyValue } from "../field-ui.tsx";

export function FormulaDisplay({ value, schema }: FieldViewProps<unknown>) {
  const def = schema as FormulaColumnDef;
  if (value === null || value === undefined) {
    return <EmptyValue />;
  }
  return (
    <span title={`formula: ${def.expression}`} className="italic">
      {String(value)}
    </span>
  );
}
