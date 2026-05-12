import { create } from "zustand";

interface CommandPaletteState {
  isOpen: boolean;
  query: string;
  open(): void;
  close(): void;
  setQuery(q: string): void;
}

export const useCommandPaletteStore = create<CommandPaletteState>()((set) => ({
  isOpen: false,
  query: "",
  open: () => set({ isOpen: true, query: "" }),
  close: () => set({ isOpen: false }),
  setQuery: (query) => set({ query }),
}));
