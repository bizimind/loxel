/**
 * Per-worktree repository selection state (commit selection, diff source).
 * Each worktree gets its own store instance via the worktree store factory.
 */
import type { CommitInfo } from "@/api/git-models";

import { createWorktreeStore } from "./worktree-store";

export type DiffSource = {
  type: "staged" | "unstaged" | "commit" | "range" | "uncommitted";
  commit?: string;
  range?: string;
  worktree?: string;
  base?: string;
};

interface RepositoryState {
  selectedCommits: Set<string>;
  diffSource: DiffSource | null;

  selectCommit: (hash: string, multi?: boolean) => void;
  selectCommitRange: (hash: string, allCommits?: CommitInfo[]) => void;
  setSelectedCommits: (commits: Set<string>) => void;
  clearSelection: () => void;
  setDiffSource: (source: DiffSource | null) => void;
}

export const {
  useStore: useRepositoryStore,
  getCurrent: getCurrentRepositoryStore,
  purge: purgeRepositoryWorktree,
} = createWorktreeStore<RepositoryState>((set, get) => ({
  selectedCommits: new Set(),
  diffSource: null,

  selectCommit: (hash, multi = false) => {
    set((state) => {
      const newSelection = new Set(multi ? state.selectedCommits : []);
      if (newSelection.has(hash)) {
        newSelection.delete(hash);
      } else {
        newSelection.add(hash);
      }
      return { selectedCommits: newSelection };
    });
  },

  selectCommitRange: (hash, allCommits) => {
    const { selectedCommits } = get();
    if (!allCommits || selectedCommits.size === 0) {
      set({ selectedCommits: new Set([hash]) });
      return;
    }

    const lastSelected = Array.from(selectedCommits).pop()!;
    const startIndex = allCommits.findIndex((c) => c.hash === lastSelected);
    const endIndex = allCommits.findIndex((c) => c.hash === hash);

    if (startIndex === -1 || endIndex === -1) return;

    const [from, to] = startIndex < endIndex ? [startIndex, endIndex] : [endIndex, startIndex];
    const newSelection = new Set(allCommits.slice(from, to + 1).map((c) => c.hash));

    set({ selectedCommits: newSelection });
  },

  setSelectedCommits: (commits) => {
    set({ selectedCommits: commits });
  },

  clearSelection: () => {
    set({ selectedCommits: new Set() });
  },

  setDiffSource: (source) => {
    set({ diffSource: source });
  },
}));
