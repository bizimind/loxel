import { useQuery } from "@tanstack/react-query";

import * as api from "@/api/client";
import type { RunningTerminal } from "@/api/running-terminals-model";

import { queryKeys } from "./query-keys";

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
