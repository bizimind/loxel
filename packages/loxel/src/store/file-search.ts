import { create } from "zustand";

import { createWorktreeStore } from "./worktree-store";

export interface FileIndexEntry {
  files: string[];
  truncated: boolean;
}

const MRU_MAX = 15;

interface FileSearchState {
  isOpen: boolean;
  query: string;

  open: () => void;
  close: () => void;
  setQuery: (q: string) => void;
}

export const useFileSearchStore = create<FileSearchState>()((set) => ({
  isOpen: false,
  query: "",

  open: () => set({ isOpen: true, query: "" }),
  close: () => set({ isOpen: false }),
  setQuery: (query) => set({ query }),
}));

interface RecentFilesState {
  /** Files opened from Quick Open, relative to the worktree, most recent first (MRU_MAX at most). */
  recent: string[];
  /** Record a file open. `relativePath` is relative to the worktree. */
  recordOpen: (relativePath: string) => void;
}

/** Quick Open's recently opened files, per worktree. */
export const { useStore: useRecentFiles, getStore: getRecentFiles } =
  createWorktreeStore<RecentFilesState>((set) => ({
    recent: [],
    recordOpen: (relativePath) =>
      set((state) => ({
        recent: [relativePath, ...state.recent.filter((p) => p !== relativePath)].slice(0, MRU_MAX),
      })),
  }));
