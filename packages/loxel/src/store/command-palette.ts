import { create } from "zustand";

/** One choice in a {@link requestQuickPick} list. */
export interface QuickPickItem {
  id: string;
  label: string;
  /** Secondary text shown muted after the label (a path, a hint); also matched by the filter. */
  description?: string;
  /** Marks the choice in effect now. */
  current?: boolean;
}

/**
 * What the palette shows: the app's commands, a list of items to pick from, or a free-text input.
 * Pick and input modes settle their request with the chosen item id or the entered text, or with
 * null when the palette is dismissed.
 */
export type CommandPaletteMode =
  | { kind: "commands" }
  | {
      kind: "pick";
      placeholder: string;
      /** null while the items load. */
      items: QuickPickItem[] | null;
      error: string | null;
      resolve: (id: string | null) => void;
    }
  | { kind: "input"; placeholder: string; resolve: (value: string | null) => void };

const COMMANDS: CommandPaletteMode = { kind: "commands" };

interface CommandPaletteState {
  isOpen: boolean;
  query: string;
  mode: CommandPaletteMode;
  /** Open the command list, dismissing a pending pick or input. */
  open(): void;
  /** Close the palette; a pending pick or input settles with null. */
  close(): void;
  /** Settle the pending pick or input with `value` and close. */
  submit(value: string): void;
  setQuery(q: string): void;
}

export const useCommandPaletteStore = create<CommandPaletteState>()((set, get) => {
  const settlePending = (value: string | null) => {
    const { mode } = get();
    if (mode.kind !== "commands") mode.resolve(value);
  };
  return {
    isOpen: false,
    query: "",
    mode: COMMANDS,
    open: () => {
      settlePending(null);
      set({ isOpen: true, query: "", mode: COMMANDS });
    },
    close: () => {
      settlePending(null);
      set({ isOpen: false, mode: COMMANDS });
    },
    submit: (value) => {
      settlePending(value);
      set({ isOpen: false, mode: COMMANDS });
    },
    setQuery: (query) => set({ query }),
  };
});

/**
 * Let the user pick one of `items` in the command palette. The palette opens at once and shows a
 * loading row until `items` settles. Resolves with the chosen item's id, or null when dismissed
 * (also when another palette request replaces this one).
 */
export function requestQuickPick(options: {
  placeholder: string;
  items: Promise<QuickPickItem[]>;
}): Promise<string | null> {
  const store = useCommandPaletteStore;
  return new Promise((resolve) => {
    const mode: CommandPaletteMode = {
      kind: "pick",
      placeholder: options.placeholder,
      items: null,
      error: null,
      resolve,
    };
    store.getState().open();
    store.setState({ mode });
    const update = (patch: { items: QuickPickItem[] } | { error: string }) => {
      const current = store.getState().mode;
      // Only while this request is still the one shown.
      if (current.kind !== "pick" || current.resolve !== resolve) return;
      store.setState({ mode: { ...current, ...patch } });
    };
    options.items.then(
      (items) => update({ items }),
      (err: unknown) => update({ error: err instanceof Error ? err.message : String(err) }),
    );
  });
}

/** Ask for a line of text in the command palette. Resolves with the text, or null when dismissed. */
export function requestTextInput(options: {
  placeholder: string;
  value?: string;
}): Promise<string | null> {
  const store = useCommandPaletteStore;
  return new Promise((resolve) => {
    store.getState().open();
    store.setState({
      query: options.value ?? "",
      mode: { kind: "input", placeholder: options.placeholder, resolve },
    });
  });
}
