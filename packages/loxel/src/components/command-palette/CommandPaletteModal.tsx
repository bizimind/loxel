import { CheckIcon, SearchIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";

import { HighlightedLabel } from "@/components/ui/HighlightedLabel";
import { KeyBindingDisplay } from "@/components/ui/key-binding-display";
import { ModalErrorBoundary } from "@/components/ui/modal-error-boundary";
import { useActionHandler } from "@/hooks/useActionHandler";
import { fuzzyMatch } from "@/lib/fuzzy-match";
import { cn } from "@/lib/utils";
import {
  type CommandPaletteMode,
  type QuickPickItem,
  useCommandPaletteStore,
} from "@/store/command-palette";
import type { ActionId } from "@/store/keybindings/action-registry";
import { ACTION_IDS, ACTIONS } from "@/store/keybindings/action-registry";
import type { KeyBinding } from "@/store/keybindings/key-combo";
import {
  getBindingsForAction,
  type KeybindingState,
  useKeybindingStore,
} from "@/store/keybindings/keybinding-store";

/** One row of the list: an action in command mode, an item in pick mode. */
interface PaletteRow {
  key: string;
  label: string;
  /** Matched characters of `label`, for highlighting. */
  indices: number[];
  description?: string;
  current?: boolean;
  bindings: readonly KeyBinding[];
}

function commandRows(query: string, kbState: KeybindingState): PaletteRow[] {
  const visible = ACTIONS.filter((a) => !a.hidden);
  const toRow = (action: (typeof visible)[number], indices: number[]): PaletteRow => ({
    key: action.id,
    label: action.label,
    indices,
    bindings: getBindingsForAction(kbState, action.id),
  });
  const q = query.trim();
  if (!q) return visible.map((a) => toRow(a, []));

  const results: Array<{ row: PaletteRow; score: number }> = [];
  for (const action of visible) {
    const match = fuzzyMatch(q, action.label);
    if (match) results.push({ row: toRow(action, match.indices), score: match.score });
  }
  results.sort((a, b) => b.score - a.score);
  return results.map(({ row }) => row);
}

function pickRows(query: string, items: QuickPickItem[]): PaletteRow[] {
  const toRow = (item: QuickPickItem, indices: number[]): PaletteRow => ({
    key: item.id,
    label: item.label,
    indices,
    description: item.description,
    current: item.current,
    bindings: [],
  });
  const q = query.trim();
  if (!q) return items.map((item) => toRow(item, []));

  const results: Array<{ row: PaletteRow; score: number }> = [];
  for (const item of items) {
    const match = fuzzyMatch(q, item.label);
    if (match) {
      results.push({ row: toRow(item, match.indices), score: match.score });
      continue;
    }
    // A description match (a path) ranks below every label match.
    const descriptionMatch = item.description ? fuzzyMatch(q, item.description) : null;
    if (descriptionMatch) {
      results.push({ row: toRow(item, []), score: descriptionMatch.score - 1_000_000 });
    }
  }
  results.sort((a, b) => b.score - a.score);
  return results.map(({ row }) => row);
}

function placeholderFor(mode: CommandPaletteMode): string {
  return mode.kind === "commands" ? "Run command" : mode.placeholder;
}

/** What the list shows when it has no rows. */
function emptyMessage(mode: CommandPaletteMode, query: string): string | null {
  switch (mode.kind) {
    case "commands":
      return query ? "No matching commands" : null;
    case "pick":
      if (mode.error) return mode.error;
      if (mode.items === null) return "Loading…";
      return query ? "No matching items" : "Nothing to pick";
    case "input":
      return "Press Enter to confirm or Escape to cancel";
    default: {
      const _exhaustive: never = mode;
      throw new Error(`Unknown palette mode: ${String(_exhaustive)}`);
    }
  }
}

/**
 * The command palette: runs app actions, and also hosts the quick picks and text inputs other
 * features request through `requestQuickPick` / `requestTextInput`.
 */
export function CommandPaletteModal() {
  const isOpen = useCommandPaletteStore((s) => s.isOpen);
  const query = useCommandPaletteStore((s) => s.query);
  const mode = useCommandPaletteStore((s) => s.mode);
  const dispatch = useActionHandler();
  const close = useCallback(() => useCommandPaletteStore.getState().close(), []);

  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Set while the dialog is closed because the store closed, so the `close` event that follows a
  // task later is not taken for a dismissal. By then a follow-up request (the input after "Enter
  // path…") may already be pending, and dismissing would cancel it.
  const closingRef = useRef(false);
  const handleDialogClose = useCallback(() => {
    if (closingRef.current) {
      closingRef.current = false;
      return;
    }
    close();
  }, [close]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (isOpen && !dialog.open) {
      dialog.showModal();
      requestAnimationFrame(() => inputRef.current?.focus());
    } else if (!isOpen && dialog.open) {
      closingRef.current = true;
      dialog.close();
    }
  }, [isOpen]);

  const kbState = useKeybindingStore();

  const rows = useMemo(() => {
    if (mode.kind === "commands") return commandRows(query, kbState);
    if (mode.kind === "pick") return pickRows(query, mode.items ?? []);
    return [];
  }, [mode, query, kbState]);

  const choose = useCallback(
    (key: string) => {
      const store = useCommandPaletteStore.getState();
      if (store.mode.kind !== "commands") {
        store.submit(key);
        return;
      }
      if (!ACTION_IDS.has(key as ActionId)) return;
      close();
      // Defer dispatch so the dialog closes before the action runs
      // (avoids focus conflicts when actions open other dialogs)
      requestAnimationFrame(() => dispatch(key as ActionId));
    },
    [close, dispatch],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const items = listRef.current?.querySelectorAll<HTMLButtonElement>("[data-command-option]");
        if (!items?.length) return;

        const active = document.activeElement;
        const arr = Array.from(items);
        const currentIdx = active instanceof HTMLButtonElement ? arr.indexOf(active) : -1;

        if (e.key === "ArrowDown") {
          const next = currentIdx < 0 ? 0 : Math.min(currentIdx + 1, arr.length - 1);
          arr[next]?.focus();
          arr[next]?.scrollIntoView({ block: "nearest" });
        } else if (currentIdx <= 0) {
          inputRef.current?.focus();
        } else {
          arr[currentIdx - 1]?.focus();
          arr[currentIdx - 1]?.scrollIntoView({ block: "nearest" });
        }
        return;
      }

      if (e.key === "Enter") {
        e.preventDefault();
        const store = useCommandPaletteStore.getState();
        if (store.mode.kind === "input") {
          const value = store.query.trim();
          if (value) store.submit(value);
          return;
        }
        const focused = document.activeElement;
        const key = focused instanceof HTMLElement ? focused.dataset.optionKey : undefined;
        if (key) {
          choose(key);
          return;
        }
        const first = listRef.current?.querySelector<HTMLElement>("[data-command-option]");
        const firstKey = first?.dataset?.optionKey;
        if (firstKey) choose(firstKey);
        return;
      }

      // Forward typing to input when an option is focused
      if (
        document.activeElement !== inputRef.current &&
        document.activeElement !== dialogRef.current
      ) {
        if (e.key === "a" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          inputRef.current?.focus();
          inputRef.current?.select();
          return;
        }
        if (e.key === "Backspace") {
          e.preventDefault();
          const store = useCommandPaletteStore.getState();
          store.setQuery(store.query.slice(0, -1));
          inputRef.current?.focus();
          return;
        }
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
          e.preventDefault();
          const store = useCommandPaletteStore.getState();
          store.setQuery(store.query + e.key);
          inputRef.current?.focus();
        }
      }
    },
    [choose],
  );

  const empty = rows.length === 0 ? emptyMessage(mode, query) : null;

  return createPortal(
    <ModalErrorBoundary name="Command Palette" onClose={close}>
      <dialog
        ref={dialogRef}
        className="bg-popover text-popover-foreground border-border mx-auto mt-[15vh] mb-auto w-[600px] max-w-[90vw] overflow-visible rounded-lg border p-0 shadow-2xl backdrop:bg-black/50"
        onClose={handleDialogClose}
        onClick={(e) => {
          if (e.target === e.currentTarget) close();
        }}
        onKeyDown={handleKeyDown}
      >
        <div className="flex flex-col">
          {/* Search input */}
          <div className="border-border flex items-center gap-1 border-b px-2 py-2.5">
            <SearchIcon className="text-muted-foreground size-4 shrink-0" />
            <input
              ref={inputRef}
              type="text"
              className="text-foreground placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-sm outline-none"
              placeholder={placeholderFor(mode)}
              value={query}
              onChange={(e) => useCommandPaletteStore.getState().setQuery(e.target.value)}
            />
          </div>

          {/* Results */}
          <div ref={listRef} className="max-h-[50vh] overflow-y-auto">
            {empty && (
              <div className="text-muted-foreground px-4 py-8 text-center text-xs">{empty}</div>
            )}
            {rows.map((row) => (
              <button
                type="button"
                key={row.key}
                data-command-option
                data-option-key={row.key}
                className={cn(
                  "border-border/50 w-full border-b px-3 py-2 text-left transition-colors outline-none last:border-b-0",
                  "hover:bg-primary/50 focus:bg-primary",
                )}
                onClick={() => choose(row.key)}
              >
                <div className="flex items-center justify-between gap-4">
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="shrink-0 truncate text-sm">
                      {query.trim() ? (
                        <HighlightedLabel text={row.label} indices={row.indices} />
                      ) : (
                        row.label
                      )}
                    </span>
                    {row.description && (
                      <span
                        className="text-muted-foreground truncate text-xs"
                        title={row.description}
                      >
                        {row.description}
                      </span>
                    )}
                  </span>
                  {row.current && <CheckIcon className="size-3.5 shrink-0" aria-label="Current" />}
                  {row.bindings.length > 0 && (
                    <span className="text-muted-foreground flex shrink-0 items-center gap-1.5 text-xs">
                      {row.bindings.map((binding) => (
                        <KeyBindingDisplay key={binding} binding={binding} />
                      ))}
                    </span>
                  )}
                </div>
              </button>
            ))}
          </div>
        </div>
      </dialog>
    </ModalErrorBoundary>,
    document.body,
  );
}
