import type {
  TableMeta,
  TableSchema,
  QueryOptions,
  Page,
  InsertResult,
  UpdateResult,
  ViewMeta,
} from "@bizimind/localdb-sdk";

import type { DataAdapter } from "./data-adapter.ts";

/**
 * Creates a DataAdapter that calls a REST API.
 * The server must expose endpoints matching the localdb REST route convention.
 *
 * @param baseUrl - e.g. "/api/localdb" or "https://host/api/localdb"
 */
export function makeRestAdapter(baseUrl: string, project?: string | null): DataAdapter {
  const base = baseUrl.replace(/\/$/, "");
  const projectSuffix = project ? `?project=${encodeURIComponent(project)}` : "";

  function url(path: string): string {
    if (!projectSuffix) return `${base}${path}`;
    // Append project param — handle paths that already have a query string (e.g. /views?tableId=N)
    const sep = path.includes("?") ? "&" : "?";
    return `${base}${path}${sep}project=${encodeURIComponent(project!)}`;
  }

  async function get<T>(path: string): Promise<T> {
    const res = await fetch(url(path));
    if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
    return res.json() as Promise<T>;
  }

  async function post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(url(path), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 422) return res.json() as Promise<T>;
    if (!res.ok) throw new Error(`POST ${path} failed: ${res.status}`);
    return res.json() as Promise<T>;
  }

  async function patch<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(url(path), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 422) return res.json() as Promise<T>;
    if (!res.ok) throw new Error(`PATCH ${path} failed: ${res.status}`);
    return res.json() as Promise<T>;
  }

  async function del(path: string): Promise<void> {
    const res = await fetch(url(path), { method: "DELETE" });
    if (!res.ok) throw new Error(`DELETE ${path} failed: ${res.status}`);
  }

  return {
    listTables: () => get<TableMeta[]>("/tables"),
    getSchema: (tableName) => get<TableSchema>(`/tables/${tableName}/schema`),

    query: <T extends Record<string, unknown>>(tableName: string, opts?: QueryOptions) =>
      post<Page<T>>(`/tables/${tableName}/query`, opts ?? {}),

    get: <T extends Record<string, unknown>>(tableName: string, id: number) =>
      get<T | null>(`/tables/${tableName}/rows/${id}`),

    insert: <T extends Record<string, unknown>>(tableName: string, row: Partial<T>) =>
      post<InsertResult<T>>(`/tables/${tableName}/rows`, row),

    update: <T extends Record<string, unknown>>(
      tableName: string,
      id: number,
      patchData: Partial<T>,
    ) => patch<UpdateResult<T>>(`/tables/${tableName}/rows/${id}`, patchData),

    delete: (tableName, id) => del(`/tables/${tableName}/rows/${id}`),

    listViews: (tableId) => get<ViewMeta[]>(`/views?tableId=${tableId}`),

    upsertView: (view) =>
      view.id ? patch<ViewMeta>(`/views/${view.id}`, view) : post<ViewMeta>("/views", view),

    deleteView: (id) => del(`/views/${id}`),
  };
}
