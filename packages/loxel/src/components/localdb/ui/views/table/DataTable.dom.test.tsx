/**
 * Regression tests for the inline add-row flow: a rejected insert must keep the draft row
 * on screen and surface the validation issues instead of discarding the user's input.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";

import type { InsertResult, TableSchema } from "@bizimind/localdb-sdk";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type React from "react";

import { localRef } from "@/api/local-server";
// Imported through the package barrel so the built-in field components get registered,
// exactly as in the app.
import { DataTable, type DataAdapter } from "@/components/localdb/ui";
import { queryKeys } from "@/queries/query-keys";

afterEach(cleanup);

const schema: TableSchema = {
  table: { id: 1, name: "tasks", label: "Tasks", createdAt: "" },
  columns: [
    { id: 1, tableId: 1, name: "title", position: 0, def: { kind: "text", label: "Title" } },
    { id: 2, tableId: 1, name: "notes", position: 1, def: { kind: "text", label: "Notes" } },
  ],
};

function makeAdapter(
  insertResult: InsertResult<Record<string, unknown>>,
  rows: Array<Record<string, unknown>> = [],
) {
  const insert = mock(() => Promise.resolve(insertResult));
  const adapter = {
    queryKey: queryKeys.localdb(localRef("/repo")),
    query: () =>
      Promise.resolve({
        rows: [...rows],
        total: rows.length,
        page: 1,
        pageSize: 50,
        hasNext: false,
      }),
    insert,
  } as unknown as DataAdapter;
  return { adapter, insert };
}

/** Render with a query client of its own, as the app's provider gives the views. */
function renderWithQueries(ui: React.ReactElement): QueryClient {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
  return queryClient;
}

async function startAddingRow() {
  fireEvent.click(await screen.findByRole("button", { name: "+ Add row" }));
  return screen.getAllByRole("textbox");
}

describe("DataTable add row", () => {
  test("a rejected insert keeps the draft row and shows the issue next to its field", async () => {
    const { adapter, insert } = makeAdapter({
      ok: false,
      issues: [{ path: ["title"], code: "required", message: '"title" is required' }],
    });
    renderWithQueries(<DataTable schema={schema} adapter={adapter} />);
    const [titleInput, notesInput] = await startAddingRow();
    fireEvent.change(notesInput!, { target: { value: "draft notes" } });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByText('"title" is required');
    expect(insert).toHaveBeenCalledTimes(1);
    expect(titleInput).toBeInTheDocument();
    expect(notesInput).toHaveValue("draft notes");
    expect(screen.queryByText(/^Error:/)).toBeNull();
  });

  test("a column without a registered field component still shows its issue", async () => {
    const refSchema: TableSchema = {
      table: schema.table,
      columns: [
        {
          id: 3,
          tableId: 1,
          name: "owner",
          position: 0,
          def: { kind: "ref", label: "Owner", targetTable: "users", targetColumn: "id" },
        },
      ],
    };
    const { adapter } = makeAdapter({
      ok: false,
      issues: [{ path: ["owner"], code: "type", message: '"owner" must be a number' }],
    });
    renderWithQueries(<DataTable schema={refSchema} adapter={adapter} />);
    const [ownerInput] = await startAddingRow();
    fireEvent.change(ownerInput!, { target: { value: "bob" } });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByText('"owner" must be a number');
    expect(ownerInput).toHaveValue("bob");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("issues without a rendered field are shown at the row level", async () => {
    const { adapter } = makeAdapter({
      ok: false,
      issues: [{ path: [], code: "unique", message: "Row must be unique" }],
    });
    renderWithQueries(<DataTable schema={schema} adapter={adapter} />);
    await startAddingRow();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Row must be unique");
  });

  test("a successful insert closes the add-row form", async () => {
    const { adapter } = makeAdapter({ ok: true, row: { id: 1, title: "x" } });
    renderWithQueries(<DataTable schema={schema} adapter={adapter} />);
    const [titleInput] = await startAddingRow();
    fireEvent.change(titleInput!, { target: { value: "x" } });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.queryByRole("button", { name: "Save" })).toBeNull());
    expect(screen.getByRole("button", { name: "+ Add row" })).toBeInTheDocument();
  });
});

describe("DataTable rows", () => {
  test("follow a change made elsewhere once the project's localdb queries are invalidated", async () => {
    const rows: Array<Record<string, unknown>> = [{ id: 1, title: "first", notes: "" }];
    const { adapter } = makeAdapter({ ok: true, row: {} }, rows);
    const queryClient = renderWithQueries(<DataTable schema={schema} adapter={adapter} />);
    await screen.findByText("first");

    // What a localdb_changed push or a resync after a reconnect does.
    rows.push({ id: 2, title: "added by an agent", notes: "" });
    await act(() =>
      queryClient.invalidateQueries({ queryKey: queryKeys.localdb(localRef("/repo")) }),
    );

    expect(await screen.findByText("added by an agent")).toBeInTheDocument();
    expect(screen.getByText("first")).toBeInTheDocument();
  });
});
