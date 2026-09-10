import { SearchIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";

import { HighlightedLabel } from "@/components/ui/HighlightedLabel";
import { KeyComboDisplay } from "@/components/ui/key-combo-display";
import { ModalErrorBoundary } from "@/components/ui/modal-error-boundary";
import { useActionHandler } from "@/hooks/useActionHandler";
import { fuzzyMatch } from "@/lib/fuzzy-match";
import { cn } from "@/lib/utils";
import { useCommandPaletteStore } from "@/store/command-palette";
import type { ActionId } from "@/store/keybindings/action-registry";
import { ACTION_IDS, ACTIONS } from "@/store/keybindings/action-registry";
import { getBindingsForAction, useKeybindingStore } from "@/store/keybindings/keybinding-store";

export function CommandPaletteModal() {
  const isOpen = useCommandPaletteStore((s) => s.isOpen);
  const query = useCommandPaletteStore((s) => s.query);
  const dispatch = useActionHandler();
  const close = useCallback(() => useCommandPaletteStore.getState().close(), []);

  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (isOpen && !dialog.open) {
      dialog.showModal();
      requestAnimationFrame(() => inputRef.current?.focus());
    } else if (!isOpen && dialog.open) {
      dialog.close();
    }
  }, [isOpen]);

  const kbState = useKeybindingStore();

  const filtered = useMemo(() => {
    const visible = ACTIONS.filter((a) => !a.hidden);
    const q = query.trim();
    if (!q) return visible.map((a) => ({ action: a, indices: [] as number[] }));

    const results: Array<{ action: (typeof visible)[number]; indices: number[]; score: number }> =
      [];
    for (const action of visible) {
      const match = fuzzyMatch(q, action.label);
      if (match) results.push({ action, indices: match.indices, score: match.score });
    }
    results.sort((a, b) => b.score - a.score);
    return results.map(({ action, indices }) => ({ action, indices }));
  }, [query]);

  const runAction = useCallback(
    (actionId: Parameters<typeof dispatch>[0]) => {
      close();
      // Defer dispatch so the dialog closes before the action runs
      // (avoids focus conflicts when actions open other dialogs)
      requestAnimationFrame(() => dispatch(actionId));
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
        const focused = document.activeElement;
        const actionId = focused instanceof HTMLElement ? focused.dataset.commandAction : undefined;
        if (actionId && ACTION_IDS.has(actionId as ActionId)) {
          runAction(actionId as ActionId);
          return;
        }
        const first = listRef.current?.querySelector<HTMLElement>("[data-command-option]");
        const firstActionId = first?.dataset?.commandAction;
        if (firstActionId && ACTION_IDS.has(firstActionId as ActionId)) {
          runAction(firstActionId as ActionId);
        }
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
    [runAction],
  );

  return createPortal(
    <ModalErrorBoundary name="Command Palette" onClose={close}>
      <dialog
        ref={dialogRef}
        className="bg-popover text-popover-foreground border-border mx-auto mt-[15vh] mb-auto w-[600px] max-w-[90vw] overflow-visible rounded-lg border p-0 shadow-2xl backdrop:bg-black/50"
        onClose={close}
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
              placeholder="Run command"
              value={query}
              onChange={(e) => useCommandPaletteStore.getState().setQuery(e.target.value)}
            />
          </div>

          {/* Results */}
          <div ref={listRef} className="max-h-[50vh] overflow-y-auto">
            {filtered.length === 0 && query && (
              <div className="text-muted-foreground px-4 py-8 text-center text-xs">
                No matching commands
              </div>
            )}
            {filtered.map(({ action, indices }) => {
              const bindings = getBindingsForAction(kbState, action.id);
              return (
                <button
                  type="button"
                  key={action.id}
                  data-command-option
                  data-command-action={action.id}
                  className={cn(
                    "border-border/50 w-full border-b px-3 py-2 text-left transition-colors outline-none last:border-b-0",
                    "hover:bg-primary/50 focus:bg-primary",
                  )}
                  onClick={() => runAction(action.id)}
                >
                  <div className="flex items-center justify-between gap-4">
                    <span className="truncate text-sm">
                      {query.trim() ? (
                        <HighlightedLabel text={action.label} indices={indices} />
                      ) : (
                        action.label
                      )}
                    </span>
                    {bindings.length > 0 && (
                      <span className="text-muted-foreground flex shrink-0 items-center gap-1.5 text-xs">
                        {bindings.map((combo) => (
                          <KeyComboDisplay key={combo} combo={combo} />
                        ))}
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </dialog>
    </ModalErrorBoundary>,
    document.body,
  );
}
