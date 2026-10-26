import { create } from "zustand";

interface SymbolSearchState {
  isOpen: boolean;
  query: string;
  open: () => void;
  close: () => void;
  setQuery: (q: string) => void;
}

export const useSymbolSearchStore = create<SymbolSearchState>()((set) => ({
  isOpen: false,
  query: "",
  open: () => set({ isOpen: true, query: "" }),
  close: () => set({ isOpen: false }),
  setQuery: (query) => set({ query }),
}));
