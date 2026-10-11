/**
 * Regression tests for seeding ColumnDefEditor's state from `initial`: editing an
 * existing column must preserve its constraints instead of resetting them to defaults.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";

import type { ColumnDef } from "@bizimind/localdb-sdk";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { ColumnDefEditor } from "./ColumnDefEditor";

afterEach(cleanup);

function renderEditor(initial: ColumnDef, key?: string) {
  const onSave = mock((_def: ColumnDef) => {});
  const view = render(
    <ColumnDefEditor key={key} open initial={initial} onSave={onSave} onCancel={() => {}} />,
  );
  return { onSave, view };
}

function saveAndGetDef(onSave: ReturnType<typeof mock<(def: ColumnDef) => void>>): ColumnDef {
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(onSave).toHaveBeenCalledTimes(1);
  return onSave.mock.calls[0]![0];
}

describe("ColumnDefEditor seeding from initial", () => {
  test("re-saving an untouched number column keeps its constraints", () => {
    const initial: ColumnDef = {
      kind: "number",
      label: "Score",
      nullable: false,
      unique: true,
      min: 1,
      max: 10,
      integer: true,
      options: { source: "inline", items: [{ value: 1, label: "One", position: 0 }] },
    };
    const { onSave } = renderEditor(initial);

    expect(screen.getByDisplayValue("1")).toBeInTheDocument();
    expect(screen.getByDisplayValue("10")).toBeInTheDocument();
    expect(saveAndGetDef(onSave)).toEqual(initial);
  });

  test("re-saving an untouched multi text column with a max length keeps its constraints", () => {
    const initial: ColumnDef = {
      kind: "text",
      label: "Tags",
      nullable: true,
      multi: true,
      maxLength: 32,
    };
    const { onSave } = renderEditor(initial);

    expect(saveAndGetDef(onSave)).toEqual(initial);
  });

  test("re-saving an untouched formula column keeps its expression and result type", () => {
    const initial: ColumnDef = {
      kind: "formula",
      label: "Total",
      expression: "price * qty",
      resultKind: "text",
    };
    const { onSave } = renderEditor(initial);

    expect(screen.getByDisplayValue("price * qty")).toBeInTheDocument();
    expect(saveAndGetDef(onSave)).toEqual(initial);
  });

  test("ref-sourced options are not treated as inline options", () => {
    const initial: ColumnDef = {
      kind: "text",
      label: "Owner",
      options: { source: "ref", table: "users", valueColumn: "id", labelColumn: "name" },
    };
    const { onSave } = renderEditor(initial);

    expect(saveAndGetDef(onSave)).toEqual({ kind: "text", label: "Owner", nullable: true });
  });

  test("remounting with a new key re-seeds the state for a different column", () => {
    const first: ColumnDef = { kind: "number", label: "A", min: 5 };
    const second: ColumnDef = { kind: "number", label: "B", max: 7 };
    const { view } = renderEditor(first, "A");
    expect(screen.getByDisplayValue("5")).toBeInTheDocument();

    const onSave = mock((_def: ColumnDef) => {});
    view.rerender(
      <ColumnDefEditor key="B" open initial={second} onSave={onSave} onCancel={() => {}} />,
    );

    expect(screen.queryByDisplayValue("5")).toBeNull();
    expect(screen.getByDisplayValue("7")).toBeInTheDocument();
    expect(saveAndGetDef(onSave)).toEqual({ ...second, nullable: true });
  });
});
