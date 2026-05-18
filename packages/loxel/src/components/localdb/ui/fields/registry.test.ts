import { describe, expect, test } from "bun:test";

import type { ColumnDef } from "@bizimind/localdb-sdk";

import { defaultComponentKeyForColumn } from "./registry.ts";

describe("defaultComponentKeyForColumn", () => {
  test("uses text input for open text columns", () => {
    const def: ColumnDef = { kind: "text", label: "Title" };

    expect(defaultComponentKeyForColumn(def)).toBe("text-input");
  });

  test("uses checkbox for boolean columns", () => {
    const def: ColumnDef = { kind: "boolean", label: "Done" };

    expect(defaultComponentKeyForColumn(def)).toBe("boolean-checkbox");
  });

  test("uses single select for option-backed text columns", () => {
    const def: ColumnDef = {
      kind: "text",
      label: "Priority",
      options: { source: "inline", items: [{ value: "high", label: "High", position: 0 }] },
    };

    expect(defaultComponentKeyForColumn(def)).toBe("single-select");
  });

  test("uses multi select for option-backed multi text columns", () => {
    const def: ColumnDef = {
      kind: "text",
      label: "Tags",
      multi: true,
      options: { source: "inline", items: [{ value: "bug", label: "Bug", position: 0 }] },
    };

    expect(defaultComponentKeyForColumn(def)).toBe("multi-select-checkboxes");
  });
});
