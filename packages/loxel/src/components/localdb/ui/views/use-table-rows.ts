import type { Page, QueryOptions } from "@bizimind/localdb-sdk";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import type { DataAdapter } from "../adapters/data-adapter.ts";

export type Row = Record<string, unknown>;

/**
 * A page of `tableName`'s rows, cached under the adapter's `queryKey`: whatever invalidates that
 * (a change the server pushes, a resync after a reconnect) refreshes every view showing them, on
 * screen or not, in place, so a view keeps its page and an edit in progress. `setPage` changes the
 * cached page, for an optimistic edit; `refresh` refetches the table's rows after a write.
 */
export function useTableRows(adapter: DataAdapter, tableName: string, options: QueryOptions) {
  const queryClient = useQueryClient();
  const tableKey = [...adapter.queryKey, "rows", tableName];
  const queryKey = [...tableKey, options];
  const query = useQuery({ queryKey, queryFn: () => adapter.query<Row>(tableName, options) });
  // Stable while the key is, so a view can depend on them (a drag's listeners).
  const keyHash = JSON.stringify(queryKey);
  const setPage = useCallback(
    (update: (page: Page<Row>) => Page<Row>) => {
      const key: unknown[] = JSON.parse(keyHash);
      // A refetch started before the edit would land after it and show the old value again.
      void queryClient.cancelQueries({ queryKey: key, exact: true });
      queryClient.setQueryData<Page<Row>>(key, (page) => page && update(page));
    },
    [queryClient, keyHash],
  );
  const refresh = useCallback(
    () =>
      queryClient.invalidateQueries({ queryKey: (JSON.parse(keyHash) as unknown[]).slice(0, -1) }),
    [queryClient, keyHash],
  );
  return {
    page: query.data,
    loading: query.isPending,
    error: query.error ? String(query.error) : null,
    setPage,
    refresh,
  };
}
