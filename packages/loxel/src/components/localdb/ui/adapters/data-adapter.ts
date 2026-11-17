import type {
  TableMeta,
  TableSchema,
  QueryOptions,
  Page,
  InsertResult,
  UpdateResult,
  ViewMeta,
} from "@bizimind/localdb-sdk";

import type { LocalDbKey } from "@/queries/query-keys";

/**
 * Protocol-agnostic data access interface.
 * Implement this to connect the UI to any backend: REST, WebSocket, Convex, or in-process SDK.
 */
export interface DataAdapter {
  /**
   * The prefix of the TanStack Query keys the views cache this adapter's data under: invalidating
   * it refreshes every view of it. Loxel's `queryKeys.localdb` builds it, since Loxel accepts only
   * keys its builders made.
   */
  readonly queryKey: LocalDbKey;

  // Schema
  listTables(): Promise<TableMeta[]>;
  getSchema(tableName: string): Promise<TableSchema>;

  // Data
  query<T extends Record<string, unknown>>(
    tableName: string,
    opts?: QueryOptions,
  ): Promise<Page<T>>;
  get<T extends Record<string, unknown>>(tableName: string, id: number): Promise<T | null>;
  insert<T extends Record<string, unknown>>(
    tableName: string,
    row: Partial<T>,
  ): Promise<InsertResult<T>>;
  update<T extends Record<string, unknown>>(
    tableName: string,
    id: number,
    patch: Partial<T>,
  ): Promise<UpdateResult<T>>;
  delete(tableName: string, id: number): Promise<void>;

  // Views
  listViews(tableId: number): Promise<ViewMeta[]>;
  upsertView(view: Omit<ViewMeta, "id"> & { id?: number }): Promise<ViewMeta>;
  deleteView(id: number): Promise<void>;
}
