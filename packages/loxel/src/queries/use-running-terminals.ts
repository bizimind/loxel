import { useQuery } from "@tanstack/react-query";

import * as api from "@/api/client";
import type { RunningTerminal } from "@/api/running-terminals-model";
import { queryClient } from "@/query-client";

import { queryKeys } from "./query-keys";

// Terminals may have started or ended while the connection was down.
api.wsClient.onReconnect(() => {
  void queryClient.invalidateQueries({ queryKey: queryKeys.runningTerminals() });
});

/**
 * The terminals the server runs, without their foreground programs. Kept current by
 * `terminals_changed` (ws-bridge.ts), so a read never goes stale on its own.
 */
export function useRunningTerminals(
  options: { enabled?: boolean } = {},
): RunningTerminal[] | undefined {
  const { data } = useQuery({
    queryKey: queryKeys.runningTerminals(),
    queryFn: () => api.getRunningTerminals({ programs: false }),
    enabled: options.enabled ?? true,
    staleTime: Infinity,
  });
  return data;
}
