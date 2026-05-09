/**
 * Per-worktree UI state (selections, search, panel layout).
 * Each worktree gets its own store instance via the worktree store factory.
 */
import { createWorktreeStore } from "./worktree-store";

export type PanelSide = "left" | "right";
export type BranchFilterPreset =
  | "all"
  | "current-and-main"
  | "recent-1d"
  | "recent-2d"
  | "recent-3d"
  | "recent-5d";

export type DateRangePreset = "all" | "today" | "7d" | "30d" | "custom";

export interface SearchFilters {
  branches: string[];
  users: string[];
  dateRange: DateRangePreset;
  customDateFrom: string | null;
  customDateTo: string | null;
  paths: string;
}

const DEFAULT_SEARCH_FILTERS: SearchFilters = {
  branches: [],
  users: [],
  dateRange: "all",
  customDateFrom: null,
  customDateTo: null,
  paths: "",
};

interface WorktreeUIState {
  // Branches panel collapse & side (used by GraphPanel's inner dockview)
  branchesPanelCollapsed: boolean;
  toggleBranchesPanel: () => void;
  branchesPanelSide: PanelSide;
  setBranchesPanelSide: (side: PanelSide) => void;

  // Commit search
  searchQuery: string;
  setSearchQuery: (query: string) => void;

  // Search filters
  searchFilters: SearchFilters;
  setSearchFilters: (filters: Partial<SearchFilters>) => void;
  resetSearchFilters: () => void;

  // Branch filtering
  branchFilterPreset: BranchFilterPreset;
  setBranchFilterPreset: (preset: BranchFilterPreset) => void;

  // Selected diff file (shared between file tree and diff view)
  selectedDiffFile: string | null;
  setSelectedDiffFile: (file: string | null) => void;

  // Graph column layout
  graphColumnSizing: Record<string, number>;
  setGraphColumnSizing: (sizing: Record<string, number>) => void;
  graphColumnOrder: string[];
  setGraphColumnOrder: (order: string[]) => void;

  // Project files panel
  selectedProjectFile: string | null;
  setSelectedProjectFile: (file: string | null) => void;
  expandedProjectFolders: Set<string>;
  toggleProjectFolder: (folder: string) => void;
  setExpandedProjectFolders: (folders: Set<string>) => void;
  /** Update selected file when a path is renamed or moved. */
  renameProjectPaths: (oldPrefix: string, newPrefix: string) => void;
}

export const {
  useStore: useWorktreeUI,
  getCurrent: getCurrentWorktreeUI,
  purge: purgeUIWorktree,
} = createWorktreeStore<WorktreeUIState>((set) => ({
  branchesPanelCollapsed: false,
  toggleBranchesPanel: () => set((s) => ({ branchesPanelCollapsed: !s.branchesPanelCollapsed })),
  branchesPanelSide: "left",
  setBranchesPanelSide: (side) => set({ branchesPanelSide: side }),

  searchQuery: "",
  setSearchQuery: (query) => set({ searchQuery: query }),

  searchFilters: DEFAULT_SEARCH_FILTERS,
  setSearchFilters: (filters) =>
    set((s) => ({ searchFilters: { ...s.searchFilters, ...filters } })),
  resetSearchFilters: () => set({ searchFilters: DEFAULT_SEARCH_FILTERS }),

  branchFilterPreset: "all",
  setBranchFilterPreset: (preset) => set({ branchFilterPreset: preset }),

  selectedDiffFile: null,
  setSelectedDiffFile: (file) => set({ selectedDiffFile: file }),

  graphColumnSizing: {},
  setGraphColumnSizing: (sizing) => set({ graphColumnSizing: sizing }),
  graphColumnOrder: [],
  setGraphColumnOrder: (order) => set({ graphColumnOrder: order }),

  selectedProjectFile: null,
  setSelectedProjectFile: (file) => set({ selectedProjectFile: file }),
  expandedProjectFolders: new Set(),
  toggleProjectFolder: (folder) =>
    set((s) => {
      const next = new Set(s.expandedProjectFolders);
      if (next.has(folder)) next.delete(folder);
      else next.add(folder);
      return { expandedProjectFolders: next };
    }),
  setExpandedProjectFolders: (folders) => set({ expandedProjectFolders: new Set(folders) }),
  renameProjectPaths: (oldPrefix, newPrefix) =>
    set((s) => {
      let sel = s.selectedProjectFile;
      if (sel === oldPrefix) {
        sel = newPrefix;
      } else if (sel?.startsWith(oldPrefix + "/")) {
        sel = newPrefix + sel.slice(oldPrefix.length);
      }
      const expandedProjectFolders = remapPaths(s.expandedProjectFolders, oldPrefix, newPrefix);
      return {
        ...(sel !== s.selectedProjectFile ? { selectedProjectFile: sel } : {}),
        ...(expandedProjectFolders !== s.expandedProjectFolders ? { expandedProjectFolders } : {}),
      };
    }),
}));

function remapPaths(paths: Set<string>, oldPrefix: string, newPrefix: string): Set<string> {
  let changed = false;
  const next = new Set<string>();
  for (const p of paths) {
    if (p === oldPrefix) {
      next.add(newPrefix);
      changed = true;
    } else if (p.startsWith(oldPrefix + "/")) {
      next.add(newPrefix + p.slice(oldPrefix.length));
      changed = true;
    } else {
      next.add(p);
    }
  }
  return changed ? next : paths;
}
