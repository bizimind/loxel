import type {
  TableMeta,
  TableSchema,
  QueryOptions,
  Page,
  InsertResult,
  UpdateResult,
  ViewMeta,
} from "@bizimind/localdb-sdk";
import { identifierSchema } from "@bizimind/localdb-sdk/validation";

import { localConnection } from "@/api/local-server";
import { connectionOf } from "@/api/server-connection";
import type { WorktreeRef } from "@/api/worktree-ref";
import { queryKeys } from "@/queries/query-keys";

import type { DataAdapter } from "./data-adapter.ts";

/**
 * The localdb API of `project`'s server, which keeps the project's databases. With no project
 * (Home) it is the window's own server's, which answers that no project is named.
 */
export function localDbApiUrl(project: WorktreeRef | null | undefined): string {
  const connection = project ? connectionOf(project.server) : localConnection();
  return connection.apiUrl("/localdb");
}

/**
 * Whether `name` can name a table: the SDK's identifier rule. Names come from documents (a
 * `:::localdb` block's `table:`) and from server responses, and each one is a single segment of a
 * request path.
 */
export function isTableName(name: string): boolean {
  return identifierSchema.safeParse(name).success;
}

/** The path of table `name`'s routes, followed by `rest`. */
function tablePath(name: string, rest = ""): string {
  if (!isTableName(name)) throw new Error(`Invalid table name: ${JSON.stringify(name)}`);
  return `/tables/${encodeURIComponent(name)}${rest}`;
}

/** One request path segment for a row or view id. */
function idSegment(id: number): string {
  return encodeURIComponent(String(id));
}

/**
 * Creates a DataAdapter that calls a REST API.
 * The server must expose endpoints matching the localdb REST route convention.
 *
 * @param baseUrl - e.g. `localDbApiUrl(project)` or "https://host/api/localdb"
 */
export function makeRestAdapter(baseUrl: string, projectRef?: WorktreeRef | null): DataAdapter {
  const base = baseUrl.replace(/\/$/, "");
  const project = projectRef?.path;

  function url(path: string, query: Record<string, string> = {}): string {
    const params = new URLSearchParams(query);
    if (project) params.set("project", project);
    const search = params.toString();
    return `${base}${path}${search ? `?${search}` : ""}`;
  }

  async function get<T>(path: string, query?: Record<string, string>): Promise<T> {
    const res = await fetch(url(path, query));
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
    // The server requires a JSON content type on every mutation, including body-less deletes.
    const res = await fetch(url(path), {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
    });
    if (!res.ok) throw new Error(`DELETE ${path} failed: ${res.status}`);
  }

  // Table methods are async so an invalid table name rejects like a failed request.
  return {
    queryKey: queryKeys.localdb(projectRef ?? null),
    listTables: () => get<TableMeta[]>("/tables"),
    getSchema: async (tableName) => get<TableSchema>(tablePath(tableName, "/schema")),

    query: async <T extends Record<string, unknown>>(tableName: string, opts?: QueryOptions) =>
      post<Page<T>>(tablePath(tableName, "/query"), opts ?? {}),

    get: async <T extends Record<string, unknown>>(tableName: string, id: number) =>
      get<T | null>(tablePath(tableName, `/rows/${idSegment(id)}`)),

    insert: async <T extends Record<string, unknown>>(tableName: string, row: Partial<T>) =>
      post<InsertResult<T>>(tablePath(tableName, "/rows"), row),

    update: async <T extends Record<string, unknown>>(
      tableName: string,
      id: number,
      patchData: Partial<T>,
    ) => patch<UpdateResult<T>>(tablePath(tableName, `/rows/${idSegment(id)}`), patchData),

    delete: async (tableName, id) => del(tablePath(tableName, `/rows/${idSegment(id)}`)),

    listViews: (tableId) => get<ViewMeta[]>("/views", { tableId: String(tableId) }),

    upsertView: (view) =>
      view.id
        ? patch<ViewMeta>(`/views/${idSegment(view.id)}`, view)
        : post<ViewMeta>("/views", view),

    deleteView: (id) => del(`/views/${idSegment(id)}`),
  };
}
