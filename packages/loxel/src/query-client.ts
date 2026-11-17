import { onlineManager, QueryClient } from "@tanstack/react-query";

import { wsClient } from "@/api/client";

// Every query and mutation goes to the Loxel server, so whether it can run depends on reaching
// that server, not on the browser's network state: a laptop with no network still reaches a local
// server. Queries wait while the socket reconnects and run once it is back.
onlineManager.setEventListener((setOnline) =>
  wsClient.onConnectionStateChange(() => {
    setOnline(wsClient.getConnectionState() !== "reconnecting");
  }),
);

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Data stays fresh until explicitly invalidated by WebSocket pushes
      // (status_changed, log_changed, refs_changed) or mutation onSuccess handlers.
      // This eliminates refetches on component mount/remount (including StrictMode
      // double-invoke) — cached data is served instantly with zero network requests.
      // After a reconnect the bridge invalidates what pushes may have missed.
      staleTime: Number.POSITIVE_INFINITY,
      gcTime: 30 * 60_000, // keep inactive cache 30min (covers project switch-back)
      refetchOnWindowFocus: false,
      retry: 1,
    },
    mutations: {
      // A user action runs now or fails visibly; it never waits for the connection and lands
      // later, when a discard or a reset may no longer be what the user wants.
      networkMode: "always",
    },
  },
});
