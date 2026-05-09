/**
 * Notification badge state for toolbar panel icons.
 *
 * Tracks unviewed notification counts per panel. The logs panel uses this
 * to show a red dot when error-level entries arrive while the panel is not
 * active. Other panels can adopt the same pattern in the future.
 *
 * Badge counts are ephemeral session state. `lastSeenErrorTotal`, however,
 * is persisted to localStorage so the logs badge can reconcile against the
 * server's monotonic error total across page reloads without re-counting
 * previously-viewed errors.
 */
import { create } from "zustand";

import { STORAGE_PREFIX } from "@/lib/env";

import type { PanelId } from "./panel-config";

const LAST_SEEN_ERROR_TOTAL_KEY = `${STORAGE_PREFIX}-logs-last-seen-error-total`;

function readLastSeenErrorTotal(): number {
  try {
    const raw = localStorage.getItem(LAST_SEEN_ERROR_TOTAL_KEY);
    if (raw === null) return 0;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  } catch {
    // localStorage unavailable (SSR, private mode) — treat as first-run
    return 0;
  }
}

function writeLastSeenErrorTotal(total: number): void {
  try {
    localStorage.setItem(LAST_SEEN_ERROR_TOTAL_KEY, String(total));
  } catch {
    // Non-fatal — worst case the badge may drift after a reload
  }
}

interface PanelBadgeState {
  /** Badge counts per panel. Missing or 0 = no badge. */
  counts: Partial<Record<PanelId, number>>;

  /**
   * Last server-reported total of error-level log entries the user has seen.
   * Persisted to localStorage; used with `log_error_snapshot` to reconcile
   * the logs badge on subscribe / reconnect without drift.
   */
  lastSeenErrorTotal: number;

  /** Increment badge count for a panel. */
  increment: (panelId: PanelId, amount?: number) => void;

  /** Clear badge for a panel (e.g. when it becomes active/visible). */
  clear: (panelId: PanelId) => void;

  /**
   * Reconcile the logs badge against a server-reported running total.
   * Sets the badge to `max(0, total - lastSeenErrorTotal)`.
   * If `logsActive` is true, the user is viewing the panel: the badge is
   * cleared and `lastSeenErrorTotal` is advanced to `total` so any future
   * snapshot compares against the just-viewed baseline.
   */
  reconcileLogsFromSnapshot: (total: number, logsActive: boolean) => void;

  /**
   * Mark the current server error total as seen (advances `lastSeenErrorTotal`)
   * and clears the logs badge. Called when the logs panel becomes active.
   */
  markLogsErrorsSeen: (total: number) => void;

  /**
   * Advance `lastSeenErrorTotal` by an incoming delta. Called when a
   * `log_error_count` delta arrives while the logs panel is already active:
   * the user is seeing those errors live, so the baseline must move with the
   * server's running total to keep future snapshot reconciliations drift-free.
   */
  advanceSeenByDelta: (delta: number) => void;

  /**
   * Snap `lastSeenErrorTotal` forward to cover the current logs badge count
   * (baseline + unseen deltas accumulated into the badge) and clear the
   * badge. Called when the logs panel becomes active — we don't have the
   * live server total on hand, so we infer it from our own accounting.
   */
  markLogsSeenOnActivation: () => void;
}

export const usePanelBadgeStore = create<PanelBadgeState>()((set, get) => ({
  counts: {},
  lastSeenErrorTotal: readLastSeenErrorTotal(),

  increment: (panelId, amount = 1) =>
    set((state) => ({
      counts: { ...state.counts, [panelId]: (state.counts[panelId] ?? 0) + amount },
    })),

  clear: (panelId) =>
    set((state) => {
      if (!state.counts[panelId]) return state;
      const next = { ...state.counts };
      delete next[panelId];
      return { counts: next };
    }),

  reconcileLogsFromSnapshot: (total, logsActive) => {
    // Server restart: total resets to a value below our baseline. The server
    // no longer knows about the previously-seen errors, so drop our baseline
    // to zero — the `total` we see now is all we can reconcile against.
    let baseline = get().lastSeenErrorTotal;
    if (total < baseline) {
      baseline = 0;
      writeLastSeenErrorTotal(0);
      set({ lastSeenErrorTotal: 0 });
    }

    if (logsActive) {
      // User is looking at the panel — everything up to `total` is "seen".
      get().markLogsErrorsSeen(total);
      return;
    }

    const unseen = Math.max(0, total - baseline);
    set((state) => {
      const next = { ...state.counts };
      if (unseen > 0) {
        next.logs = unseen;
      } else {
        delete next.logs;
      }
      return { counts: next };
    });
  },

  markLogsErrorsSeen: (total) => {
    writeLastSeenErrorTotal(total);
    set((state) => {
      const next = { ...state.counts };
      delete next.logs;
      return { counts: next, lastSeenErrorTotal: total };
    });
  },

  advanceSeenByDelta: (delta) => {
    const next = get().lastSeenErrorTotal + delta;
    get().markLogsErrorsSeen(next);
  },

  markLogsSeenOnActivation: () => {
    const state = get();
    const inferredTotal = state.lastSeenErrorTotal + (state.counts.logs ?? 0);
    state.markLogsErrorsSeen(inferredTotal);
  },
}));
