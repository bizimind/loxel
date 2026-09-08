import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import type { SearchMatch } from "@/api/search-model";
import type { SearchScope, WorkspacePackage } from "@/components/search/search-scope-model";
import { scopeKey } from "@/components/search/search-scope-model";
import { STORAGE_PREFIX } from "@/lib/env";

import { serverSearchStorage } from "./server-storage";

interface SearchState {
  isOpen: boolean;
  query: string;
  regex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  results: SearchMatch[];
  truncated: boolean;
  selectedIndex: number;
  loading: boolean;

  // Scope filter
  scopes: SearchScope[];
  scopeFilterOpen: boolean;
  scopeFilterQuery: string;
  availablePackages: WorkspacePackage[];
  availableDirs: string[];
  availableExtensions: string[];
  recentCustomPaths: string[];

  open: () => void;
  close: () => void;
  setQuery: (q: string) => void;
  toggleRegex: () => void;
  toggleCaseSensitive: () => void;
  toggleWholeWord: () => void;
  setResults: (results: SearchMatch[], truncated: boolean) => void;
  setSelectedIndex: (idx: number) => void;
  setLoading: (loading: boolean) => void;

  // Scope actions
  setScopes: (scopes: SearchScope[]) => void;
  toggleScope: (scope: SearchScope) => void;
  removeScope: (scope: SearchScope) => void;
  setScopeFilterOpen: (open: boolean) => void;
  setScopeFilterQuery: (q: string) => void;
  setAvailablePackages: (pkgs: WorkspacePackage[]) => void;
  setAvailableDirs: (dirs: string[]) => void;
  setAvailableExtensions: (exts: string[]) => void;
  addRecentCustomPath: (path: string) => void;
}

/** Stable string key for the current scope selection, usable as a useEffect dep. */
export function scopesKey(scopes: SearchScope[]): string {
  return scopes.map(scopeKey).sort().join("|");
}

export const useSearchStore = create<SearchState>()(
  persist(
    (set) => ({
      isOpen: false,
      query: "",
      regex: false,
      caseSensitive: false,
      wholeWord: false,
      results: [],
      truncated: false,
      selectedIndex: 0,
      loading: false,

      scopes: [],
      scopeFilterOpen: false,
      scopeFilterQuery: "",
      availablePackages: [],
      availableDirs: [],
      availableExtensions: [],
      recentCustomPaths: [],

      open: () =>
        set({
          isOpen: true,
          query: "",
          results: [],
          truncated: false,
          selectedIndex: 0,
          loading: false,
          scopes: [],
          scopeFilterOpen: false,
          scopeFilterQuery: "",
        }),
      close: () => set({ isOpen: false }),
      setQuery: (query) => set({ query, selectedIndex: 0 }),
      toggleRegex: () => set((s) => ({ regex: !s.regex, selectedIndex: 0 })),
      toggleCaseSensitive: () =>
        set((s) => ({ caseSensitive: !s.caseSensitive, selectedIndex: 0 })),
      toggleWholeWord: () => set((s) => ({ wholeWord: !s.wholeWord, selectedIndex: 0 })),
      setResults: (results, truncated) =>
        set({ results, truncated, loading: false, selectedIndex: 0 }),
      setSelectedIndex: (selectedIndex) => set({ selectedIndex }),
      setLoading: (loading) => set({ loading }),

      setScopes: (scopes) => set({ scopes, selectedIndex: 0 }),
      toggleScope: (scope) =>
        set((s) => {
          const key = scopeKey(scope);
          const exists = s.scopes.some((sc) => scopeKey(sc) === key);

          if (exists) {
            // Remove it
            const next = s.scopes.filter((sc) => scopeKey(sc) !== key);
            return { scopes: next, selectedIndex: 0 };
          }

          // Presets are standalone — selecting one replaces everything
          if (scope.type === "preset") {
            return { scopes: [scope], selectedIndex: 0 };
          }

          // Packages/custom combine — clear any active preset first
          const withoutPresets = s.scopes.filter((sc) => sc.type !== "preset");
          return { scopes: [...withoutPresets, scope], selectedIndex: 0 };
        }),
      removeScope: (scope) =>
        set((s) => ({
          scopes: s.scopes.filter((sc) => scopeKey(sc) !== scopeKey(scope)),
          selectedIndex: 0,
        })),
      setScopeFilterOpen: (scopeFilterOpen) => set({ scopeFilterOpen }),
      setScopeFilterQuery: (scopeFilterQuery) => set({ scopeFilterQuery }),
      setAvailablePackages: (availablePackages) => set({ availablePackages }),
      setAvailableDirs: (availableDirs) => set({ availableDirs }),
      setAvailableExtensions: (availableExtensions) => set({ availableExtensions }),
      addRecentCustomPath: (path) =>
        set((s) => ({
          recentCustomPaths: [path, ...s.recentCustomPaths.filter((p) => p !== path)].slice(0, 10),
        })),
    }),
    {
      name: `${STORAGE_PREFIX}-search`,
      storage: createJSONStorage(() => serverSearchStorage),
      partialize: (state) => ({ recentCustomPaths: state.recentCustomPaths }),
    },
  ),
);
