import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

import { toServerId, worktreeRef } from "@/api/worktree-ref";

import { isTableName, makeRestAdapter } from "./rest";

const BASE = "/api/localdb";
const project = worktreeRef(toServerId("test-server"), "/repo with space");

/** The adapter, with every request it sends recorded as `METHOD url`. */
function adapter() {
  const requests: string[] = [];
  spyOn(globalThis, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    requests.push(`${init?.method ?? "GET"} ${String(input)}`);
    return Response.json({});
  }) as typeof fetch);
  return { rest: makeRestAdapter(BASE, project), requests };
}

afterEach(() => {
  mock.restore();
});

describe("isTableName", () => {
  test("accepts the SDK's identifiers and nothing else", () => {
    expect(isTableName("tasks")).toBe(true);
    expect(isTableName("sprint_2")).toBe(true);
    for (const name of ["", "Tasks", "2tasks", "..", "a/b", "a?b", "a#b", "a%2fb", "a b"]) {
      expect(isTableName(name)).toBe(false);
    }
  });
});

describe("makeRestAdapter", () => {
  test("puts the table name and ids in their own path segments, and the project in the query", async () => {
    const { rest, requests } = adapter();
    await rest.getSchema("tasks");
    await rest.update("tasks", 7, { title: "x" });
    await rest.listViews(3);
    await rest.deleteView(4);
    expect(requests).toEqual([
      "GET /api/localdb/tables/tasks/schema?project=%2Frepo+with+space",
      "PATCH /api/localdb/tables/tasks/rows/7?project=%2Frepo+with+space",
      "GET /api/localdb/views?tableId=3&project=%2Frepo+with+space",
      "DELETE /api/localdb/views/4?project=%2Frepo+with+space",
    ]);
  });

  test("sends no request for a table name that is not an identifier", async () => {
    const { rest, requests } = adapter();
    for (const name of ["../../version", "tasks?x=1", "tasks#", "..", "a/b"]) {
      // oxlint-disable-next-line no-await-in-loop -- each name is checked on its own
      await expect(rest.getSchema(name)).rejects.toThrow("Invalid table name");
      // oxlint-disable-next-line no-await-in-loop -- each name is checked on its own
      await expect(rest.query(name)).rejects.toThrow("Invalid table name");
    }
    expect(requests).toEqual([]);
  });
});
