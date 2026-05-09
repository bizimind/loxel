import type { ColumnDef } from "@bizimind/localdb-sdk";

import type { ComponentKey, RegisteredFieldComponent } from "./field-props.ts";

type StoredFieldComponent = RegisteredFieldComponent<unknown, unknown>;

const registry = new Map<ComponentKey, StoredFieldComponent>();

const defaultComponentByKind: Partial<Record<ColumnDef["kind"], ComponentKey>> = {
  boolean: "boolean-checkbox",
  color: "color-picker",
  date: "date-input",
  datetime: "datetime-input",
  duration: "duration-input",
  longtext: "longtext-textarea",
  number: "number-input",
  text: "text-input",
  url: "url-input",
};

export function registerField<TView, TEdit = TView>(
  component: RegisteredFieldComponent<TView, TEdit>,
): void {
  registry.set(component.key, component as unknown as StoredFieldComponent);
}

export function getField(key: ComponentKey): StoredFieldComponent | undefined {
  return registry.get(key);
}

export function listFields(): StoredFieldComponent[] {
  return Array.from(registry.values());
}

export function compatibleFields(kind: ColumnDef["kind"]): StoredFieldComponent[] {
  return listFields().filter((f) => f.compatibleKinds.includes(kind));
}

/** Returns the first registered compatible component key for a kind, or undefined */
export function defaultComponentKey(kind: ColumnDef["kind"]): ComponentKey | undefined {
  return defaultComponentByKind[kind] ?? compatibleFields(kind)[0]?.key;
}

export function defaultComponentKeyForColumn(def: ColumnDef): ComponentKey | undefined {
  if ("options" in def && def.options?.source === "inline") {
    return "multi" in def && def.multi === true ? "multi-select-checkboxes" : "single-select";
  }
  return defaultComponentKey(def.kind);
}
