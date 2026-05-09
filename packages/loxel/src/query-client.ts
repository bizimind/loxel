import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Data stays fresh until explicitly invalidated by WebSocket pushes
      // (status_changed, log_changed, refs_changed) or mutation onSuccess handlers.
      // This eliminates refetches on component mount/remount (including StrictMode
      // double-invoke) — cached data is served instantly with zero network requests.
      staleTime: Number.POSITIVE_INFINITY,
      gcTime: 30 * 60_000, // keep inactive cache 30min (covers project switch-back)
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});
