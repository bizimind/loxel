import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import type { LogLevel } from "@/api/log-entry-model";
import { STORAGE_PREFIX } from "@/lib/env";
import { toggleSet } from "@/lib/set-utils";

import { serverUiStorage } from "./server-storage";

export type DiffViewMode = "split" | "unified";

interface UIState {
  // Theme
  darkMode: boolean;
  toggleDarkMode: () => void;

  // Diff view settings
  diffViewMode: DiffViewMode;
  setDiffViewMode: (mode: DiffViewMode) => void;

  // Graph settings
  showAllBranches: boolean;
  setShowAllBranches: (show: boolean) => void;

  // Diff file tree expansion toggle (global preference)
  diffFileTreeExpanded: boolean;
  setDiffFileTreeExpanded: (expanded: boolean) => void;

  // Branch favorites
  favoriteBranches: Set<string>;
  toggleFavoriteBranch: (name: string) => void;

  // Logs panel
  /** Levels to exclude from the logs panel. Empty = show all. */
  logExcludedLevels: Set<LogLevel>;
  toggleLogLevel: (level: LogLevel) => void;
  /** Categories to exclude from the logs panel. Empty = show all. */
  logExcludedCategories: Set<string>;
  toggleLogCategory: (cat: string) => void;
  /** Whether the filter sidebar is open. */
  logFilterSidebarOpen: boolean;
  setLogFilterSidebarOpen: (open: boolean) => void;
  /** Free-text filter applied to the logs panel. Empty = no text filter. */
  logTextFilter: string;
  setLogTextFilter: (value: string) => void;
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      darkMode: true,
      toggleDarkMode: () => set((s) => ({ darkMode: !s.darkMode })),

      diffViewMode: "split",
      setDiffViewMode: (mode) => set({ diffViewMode: mode }),

      showAllBranches: true,
      setShowAllBranches: (show) => set({ showAllBranches: show }),

      diffFileTreeExpanded: true,
      setDiffFileTreeExpanded: (expanded) => set({ diffFileTreeExpanded: expanded }),

      favoriteBranches: new Set<string>(),
      toggleFavoriteBranch: (name) =>
        set((s) => ({ favoriteBranches: toggleSet(s.favoriteBranches, name) })),

      // Logs panel
      logExcludedLevels: new Set<LogLevel>(),
      toggleLogLevel: (level) =>
        set((s) => ({ logExcludedLevels: toggleSet(s.logExcludedLevels, level) })),
      logExcludedCategories: new Set<string>(),
      toggleLogCategory: (cat) =>
        set((s) => ({ logExcludedCategories: toggleSet(s.logExcludedCategories, cat) })),
      logFilterSidebarOpen: true,
      setLogFilterSidebarOpen: (open) => set({ logFilterSidebarOpen: open }),
      logTextFilter: "",
      setLogTextFilter: (value) => set({ logTextFilter: value }),
    }),
    {
      name: `${STORAGE_PREFIX}-ui`,
      storage: createJSONStorage(() => serverUiStorage),
      partialize: (state) => ({
        darkMode: state.darkMode,
        diffViewMode: state.diffViewMode,
        showAllBranches: state.showAllBranches,
        diffFileTreeExpanded: state.diffFileTreeExpanded,
        favoriteBranches: Array.from(state.favoriteBranches),
        logExcludedLevels: Array.from(state.logExcludedLevels),
        logExcludedCategories: Array.from(state.logExcludedCategories),
        logFilterSidebarOpen: state.logFilterSidebarOpen,
        logTextFilter: state.logTextFilter,
      }),
      merge: (persisted, current) => ({
        ...current,
        ...(persisted as object),
        favoriteBranches: new Set(
          (persisted as { favoriteBranches?: string[] })?.favoriteBranches ?? [],
        ),
        logExcludedLevels: new Set(
          (persisted as { logExcludedLevels?: LogLevel[] })?.logExcludedLevels ?? [],
        ),
        logExcludedCategories: new Set(
          (persisted as { logExcludedCategories?: string[] })?.logExcludedCategories ?? [],
        ),
      }),
    },
  ),
);
