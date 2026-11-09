import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";

import type { UpdateState } from "@/api/update-model";
import { queryClient } from "@/query-client";

import { queryKeys } from "./query-keys";

async function fetchUpdateStatus(): Promise<UpdateState> {
  const api = window.electronAPI;
  if (!api) throw new Error("App updates exist only in the desktop app");
  return api.getUpdateStatus();
}

/** The app update's state, kept by Electron main; undefined outside the desktop app. */
export function useUpdateStatus(): UpdateState | undefined {
  const { data } = useQuery({
    queryKey: queryKeys.updateStatus(),
    queryFn: fetchUpdateStatus,
    enabled: window.electronAPI !== undefined,
    // Main pushes every change (useUpdateStatusBridge), so the first read never goes stale.
    staleTime: Infinity,
  });
  return data;
}

/** Keeps the cached update state in step with main's status changes. Mounted once, in App. */
export function useUpdateStatusBridge(): void {
  useEffect(
    () =>
      window.electronAPI?.onUpdateStatusChange((status) => {
        queryClient.setQueryData(queryKeys.updateStatus(), status);
      }),
    [],
  );
}
