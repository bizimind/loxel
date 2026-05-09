import { create } from "zustand";

export interface FileIndexEntry {
  files: string[];
  truncated: boolean;
}

const MRU_MAX = 15;

interface FileSearchState {
  isOpen: boolean;
  query: string;
  loading: boolean;
  error: boolean;

  /** Cached file index keyed by worktree path. */
  indexByWorktree: Map<string, FileIndexEntry>;
  /** Recently opened files per worktree (most recent first, capped at MRU_MAX). */
  mruByWorktree: Map<string, string[]>;

  open: () => void;
  close: () => void;
  setQuery: (q: string) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: boolean) => void;
  setFiles: (wtPath: string, files: string[], truncated: boolean) => void;
  /** Record a file open for MRU tracking. `relativePath` is relative to the worktree. */
  recordOpen: (wtPath: string, relativePath: string) => void;
}

export const useFileSearchStore = create<FileSearchState>()((set) => ({
  isOpen: false,
  query: "",
  loading: false,
  error: false,
  indexByWorktree: new Map(),
  mruByWorktree: new Map(),

  open: () => set({ isOpen: true, query: "", error: false }),
  close: () => set({ isOpen: false }),
  setQuery: (query) => set({ query }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  setFiles: (wtPath, files, truncated) =>
    set((state) => {
      const next = new Map(state.indexByWorktree);
      next.set(wtPath, { files, truncated });
      return { indexByWorktree: next, loading: false, error: false };
    }),
  recordOpen: (wtPath, relativePath) =>
    set((state) => {
      const next = new Map(state.mruByWorktree);
      const current = next.get(wtPath) ?? [];
      const filtered = current.filter((p) => p !== relativePath);
      next.set(wtPath, [relativePath, ...filtered].slice(0, MRU_MAX));
      return { mruByWorktree: next };
    }),
}));
