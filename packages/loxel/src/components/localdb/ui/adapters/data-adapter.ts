import type {
  TableMeta,
  TableSchema,
  QueryOptions,
  Page,
  InsertResult,
  UpdateResult,
  ViewMeta,
} from "@bizimind/localdb-sdk";

/**
 * Protocol-agnostic data access interface.
 * Implement this to connect the UI to any backend: REST, WebSocket, Convex, or in-process SDK.
 */
export interface DataAdapter {
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
