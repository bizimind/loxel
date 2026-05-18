/**
 * Zustand store for server log entries.
 *
 * Single canonical data source for the Logs panel — holds both historical
 * entries (loaded from REST on scroll-up) and live entries (streamed via WS).
 */
import { create } from "zustand";

import { getLogs, wsClient } from "@/api/client";
import type { LogEntry } from "@/api/log-entry-model";
import { usePanelBadgeStore } from "@/store/panel-badges";

/** Max entries kept in the store. Oldest are dropped when exceeded by live appends. */
const MAX_ENTRIES = 5000;

/** Refcount of active live-log subscriptions. Module-local state — not part of store shape. */
let liveRefcount = 0;

// Re-send subscribe_logs after WS reconnect — server forgets its subscriber
// set across sockets, but our refcount outlives the disconnect.
wsClient.onReconnect(() => {
  if (liveRefcount > 0) wsClient.send({ type: "subscribe_logs" });
});

interface LogStoreState {
  /** All log entries: historical (prepended) + live (appended). Ordered by id ascending. */
  entries: LogEntry[];
  /** Whether older entries exist on the server. */
  hasMore: boolean;
  /** Whether initial entries have been loaded. */
  initialized: boolean;
  /** Loading state for history fetch. */
  loadingMore: boolean;

  /** Append a batch of live entries from WebSocket. */
  addLiveEntries: (entries: LogEntry[]) => void;
  /** Load initial entries from REST. */
  initialize: () => Promise<void>;
  /** Load older entries (triggered by scroll-up). */
  fetchOlder: () => Promise<void>;
  /** Clear all entries. */
  clear: () => void;
  /** Subscribe to live log stream (refcounted). Sends subscribe_logs on first subscriber. */
  connectLive: () => void;
  /** Release a live-log subscription. Sends unsubscribe_logs when refcount hits 0. */
  disconnectLive: () => void;
}

export const useLogStore = create<LogStoreState>()((set, get) => ({
  entries: [],
  hasMore: false,
  initialized: false,
  loadingMore: false,

  addLiveEntries: (newEntries) => {
    if (newEntries.length === 0) return;
    set((state) => {
      // Dedup: skip entries whose id is already in the store
      const lastId = state.entries.length > 0 ? state.entries[state.entries.length - 1]!.id : -1;
      const fresh = newEntries.filter((e) => e.id > lastId);
      if (fresh.length === 0) return state;
      const combined = [...state.entries, ...fresh];
      // Trim oldest if over cap
      const trimmed =
        combined.length > MAX_ENTRIES ? combined.slice(combined.length - MAX_ENTRIES) : combined;
      return { entries: trimmed };
    });
  },

  initialize: async () => {
    if (get().initialized) return;
    try {
      const { entries, hasMore } = await getLogs({ limit: 200 });
      // REST returns newest first — reverse to get ascending order
      set({ entries: entries.reverse(), hasMore, initialized: true });
    } catch {
      // Non-fatal — panel will show empty state
      set({ initialized: true, hasMore: false });
    }
  },

  fetchOlder: async () => {
    const { entries, loadingMore, hasMore } = get();
    if (loadingMore || !hasMore || entries.length === 0) return;

    const oldestId = entries[0]!.id;
    set({ loadingMore: true });
    try {
      const result = await getLogs({ before: oldestId, limit: 200 });
      // REST returns newest first — reverse to get ascending order
      const olderEntries = result.entries.reverse();
      set((state) => ({
        entries: [...olderEntries, ...state.entries],
        hasMore: result.hasMore,
        loadingMore: false,
      }));
    } catch {
      set({ loadingMore: false });
    }
  },

  clear: () => {
    set({ entries: [], hasMore: false, initialized: false });
    usePanelBadgeStore.getState().clear("logs");
  },

  connectLive: () => {
    if (liveRefcount === 0) {
      wsClient.send({ type: "subscribe_logs" });
    }
    liveRefcount += 1;
  },

  disconnectLive: () => {
    liveRefcount = Math.max(0, liveRefcount - 1);
    if (liveRefcount === 0) {
      wsClient.send({ type: "unsubscribe_logs" });
    }
  },
}));
