import { useQuery } from "@tanstack/react-query";

import * as api from "@/api/client";
import { localServerId } from "@/api/local-server";
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
    // The window's own server's terminals, the ones its `terminals_changed` keeps current.
    queryKey: queryKeys.runningTerminals(localServerId()),
    queryFn: () => api.getRunningTerminals(localServerId(), { programs: false }),
    enabled: options.enabled ?? true,
    staleTime: Infinity,
  });
  return data;
}
