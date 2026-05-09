import { create } from "zustand";

import type {
  CommentThread,
  CreateThreadRequest,
  DiffFileContext,
  PlacedThread,
} from "@/api/review-model";

import * as api from "@/api/client";
import { frontendLog } from "@/lib/frontend-logger";

import { getActiveWt } from "./active-worktree";

interface PendingAnchor {
  side: "old" | "new";
  startLine: number;
  endLine: number;
}

interface CommentState {
  /** Placed threads from server, grouped by file path */
  placedThreadsByFile: Map<string, PlacedThread[]>;
  /** Threads that couldn't be placed (anchor lost on both sides) */
  lostThreads: PlacedThread[];
  /** Currently active (open) thread panel */
  activeThreadId: string | null;
  /** Selection anchor for creating a new thread */
  pendingAnchor: PendingAnchor | null;
  /** Loading state for fetches */
  loading: boolean;

  /** Main fetch — calls POST /api/placed-threads */
  fetchPlacedThreads: (reviewIds: string[], files: DiffFileContext[]) => Promise<void>;

  /** Get placed threads for a specific file */
  getThreadsForFile: (filePath: string) => PlacedThread[];

  /** Mutations */
  createThread: (data: CreateThreadRequest) => Promise<CommentThread>;
  addReply: (threadId: string, body: string) => Promise<void>;
  resolveThread: (threadId: string) => Promise<void>;
  reopenThread: (threadId: string) => Promise<void>;
  deleteThread: (threadId: string) => Promise<void>;
  setActiveThread: (threadId: string | null) => void;
  setPendingAnchor: (anchor: PendingAnchor | null) => void;
  clearAll: () => void;
}

export const useCommentStore = create<CommentState>((set, get) => ({
  placedThreadsByFile: new Map(),
  lostThreads: [],
  activeThreadId: null,
  pendingAnchor: null,
  loading: false,

  fetchPlacedThreads: async (reviewIds, files) => {
    if (reviewIds.length === 0) {
      set({ placedThreadsByFile: new Map(), lostThreads: [], loading: false });
      return;
    }
    set({ loading: true });
    try {
      const placed = await api.postPlacedThreads(getActiveWt(), reviewIds, files);
      const byFile = new Map<string, PlacedThread[]>();
      const lost: PlacedThread[] = [];

      for (const thread of placed) {
        if (thread.anchorStatus === "lost") {
          lost.push(thread);
        } else {
          const key = thread.filePath;
          const existing = byFile.get(key) ?? [];
          existing.push(thread);
          byFile.set(key, existing);
        }
      }

      set({ placedThreadsByFile: byFile, lostThreads: lost, loading: false });
    } catch (err) {
      frontendLog
        .child("ui")
        .error("Failed to fetch placed threads", { error: err instanceof Error ? err : undefined });
      set({ loading: false });
    }
  },

  getThreadsForFile: (filePath) => {
    return get().placedThreadsByFile.get(filePath) ?? [];
  },

  createThread: async (data) => {
    const thread = await api.createCommentThread(getActiveWt(), data);
    // Optimistically insert as a placed thread (client knows the position since it just created it)
    const placed: PlacedThread = {
      ...thread,
      displaySide: data.createdSide,
      displayStartLine: data.startLine,
      displayEndLine: data.endLine,
      anchorStatus: "exact",
    };
    set((s) => {
      const map = new Map(s.placedThreadsByFile);
      const key = data.filePath;
      const existing = map.get(key) ?? [];
      map.set(key, [...existing, placed]);
      return { placedThreadsByFile: map, pendingAnchor: null, activeThreadId: thread.id };
    });
    return thread;
  },

  addReply: async (threadId, body) => {
    const comment = await api.addCommentReply(getActiveWt(), threadId, body);
    set((s) => {
      const map = new Map(s.placedThreadsByFile);
      for (const [key, threads] of map) {
        const idx = threads.findIndex((t) => t.id === threadId);
        if (idx !== -1) {
          const updated = [...threads];
          updated[idx] = { ...updated[idx]!, comments: [...updated[idx]!.comments, comment] };
          map.set(key, updated);
          break;
        }
      }
      // Also check lost threads
      const lostIdx = s.lostThreads.findIndex((t) => t.id === threadId);
      if (lostIdx !== -1) {
        const updatedLost = [...s.lostThreads];
        updatedLost[lostIdx] = {
          ...updatedLost[lostIdx]!,
          comments: [...updatedLost[lostIdx]!.comments, comment],
        };
        return { placedThreadsByFile: map, lostThreads: updatedLost };
      }
      return { placedThreadsByFile: map };
    });
  },

  resolveThread: async (threadId) => {
    const updated = await api.updateCommentThread(getActiveWt(), threadId, "resolved");
    set((s) => updateThreadInState(s, updated));
  },

  reopenThread: async (threadId) => {
    const updated = await api.updateCommentThread(getActiveWt(), threadId, "open");
    set((s) => updateThreadInState(s, updated));
  },

  deleteThread: async (threadId) => {
    await api.deleteCommentThread(getActiveWt(), threadId);
    set((s) => {
      const map = new Map(s.placedThreadsByFile);
      for (const [key, threads] of map) {
        const filtered = threads.filter((t) => t.id !== threadId);
        if (filtered.length !== threads.length) {
          if (filtered.length === 0) {
            map.delete(key);
          } else {
            map.set(key, filtered);
          }
          break;
        }
      }
      return {
        placedThreadsByFile: map,
        lostThreads: s.lostThreads.filter((t) => t.id !== threadId),
        activeThreadId: s.activeThreadId === threadId ? null : s.activeThreadId,
      };
    });
  },

  setActiveThread: (threadId) => set({ activeThreadId: threadId, pendingAnchor: null }),
  setPendingAnchor: (anchor) => set({ pendingAnchor: anchor, activeThreadId: null }),

  clearAll: () =>
    set({
      placedThreadsByFile: new Map(),
      lostThreads: [],
      activeThreadId: null,
      pendingAnchor: null,
    }),
}));

function updateThreadInState(state: CommentState, updated: CommentThread): Partial<CommentState> {
  const map = new Map(state.placedThreadsByFile);
  for (const [key, threads] of map) {
    const idx = threads.findIndex((t) => t.id === updated.id);
    if (idx !== -1) {
      const newThreads = [...threads];
      const existing = newThreads[idx]!;
      // Preserve PlacedThread display fields, only update mutable CommentThread fields
      newThreads[idx] = {
        ...existing,
        status: updated.status,
        comments: updated.comments,
        updatedAt: updated.updatedAt,
      };
      map.set(key, newThreads);
      return { placedThreadsByFile: map };
    }
  }
  return {};
}
