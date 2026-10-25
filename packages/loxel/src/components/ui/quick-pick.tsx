import { SearchIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

import { ModalErrorBoundary } from "@/components/ui/modal-error-boundary";
import { cn } from "@/lib/utils";

interface QuickPickProps<T> {
  /** Names the picker in its error boundary. */
  name: string;
  isOpen: boolean;
  onClose: () => void;
  query: string;
  onQueryChange: (query: string) => void;
  placeholder: string;
  items: readonly T[];
  getKey: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  /** Runs on a click, on Enter on a focused item, or on Enter in the input (for the first item). */
  onAccept: (item: T) => void;
  /** Shown at the end of the input row (a spinner, a parsed `:line` suffix). */
  inputAdornment?: ReactNode;
  /** Shown in the list area when there are no items. */
  emptyState?: ReactNode;
  footer?: ReactNode;
  itemClassName?: string;
}

/**
 * The modal picker behind Quick Open and Go to Symbol: a query input over a
 * list of items. ↑/↓ move between the input and the items, Enter accepts, and typing while an item
 * is focused goes back to the query.
 */
export function QuickPick<T>({
  name,
  isOpen,
  onClose,
  query,
  onQueryChange,
  placeholder,
  items,
  getKey,
  renderItem,
  onAccept,
  inputAdornment,
  emptyState,
  footer,
  itemClassName,
}: QuickPickProps<T>) {
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

  // Keep focus in the list when the items change under a focused item.
  // Results that stream in while an item is focused leave that item focused; only an item that was
  // unmounted hands focus to the first one.
  useEffect(() => {
    if (items.length === 0) return;
    const active = document.activeElement;
    if (active === inputRef.current) return;
    const options = getOptions(listRef.current);
    if (active instanceof HTMLButtonElement && options.includes(active)) return;
    options[0]?.focus();
  }, [items]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const options = getOptions(listRef.current);
      const active = document.activeElement;
      const currentIdx = active instanceof HTMLButtonElement ? options.indexOf(active) : -1;

      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (options.length === 0) return;
        if (e.key === "ArrowUp" && currentIdx <= 0) {
          inputRef.current?.focus();
          return;
        }
        // From the input (index -1) ArrowDown lands on the first item.
        const next =
          e.key === "ArrowDown" ? Math.min(currentIdx + 1, options.length - 1) : currentIdx - 1;
        options[next]?.focus();
        options[next]?.scrollIntoView({ block: "nearest" });
        return;
      }

      if (e.key === "Enter") {
        e.preventDefault();
        const item = items[Math.max(currentIdx, 0)];
        if (item !== undefined) onAccept(item);
        return;
      }

      // Forward typing to the input while an item is focused.
      if (active === inputRef.current || active === dialogRef.current) return;
      if (e.key === "a" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
        return;
      }
      if (e.key === "Backspace") {
        e.preventDefault();
        onQueryChange(query.slice(0, -1));
        inputRef.current?.focus();
        return;
      }
      if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        onQueryChange(query + e.key);
        inputRef.current?.focus();
      }
    },
    [items, onAccept, onQueryChange, query],
  );

  return createPortal(
    <ModalErrorBoundary name={name} onClose={onClose}>
      <dialog
        ref={dialogRef}
        className="bg-popover text-popover-foreground border-border mx-auto mt-[15vh] mb-auto w-[600px] max-w-[90vw] overflow-visible rounded-lg border p-0 shadow-2xl backdrop:bg-black/50"
        onClose={onClose}
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
        onKeyDown={handleKeyDown}
      >
        <div className="flex flex-col">
          <div className="border-border flex items-center gap-1 border-b px-2 py-2.5">
            <SearchIcon className="text-muted-foreground size-4 shrink-0" />
            <input
              ref={inputRef}
              type="text"
              className="text-foreground placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-sm outline-none"
              placeholder={placeholder}
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
            />
            {inputAdornment}
          </div>

          <div ref={listRef} className="max-h-[50vh] overflow-y-auto">
            {items.length === 0 && emptyState}
            {items.map((item) => (
              <button
                type="button"
                key={getKey(item)}
                data-quick-pick-option
                className={cn(
                  "border-border/50 w-full border-b px-3 text-left transition-colors outline-none last:border-b-0",
                  "hover:bg-primary/50 focus:bg-primary",
                  itemClassName,
                )}
                onClick={() => onAccept(item)}
              >
                {renderItem(item)}
              </button>
            ))}
          </div>

          {footer}
        </div>
      </dialog>
    </ModalErrorBoundary>,
    document.body,
  );
}

/** Centered message for a picker's list area (loading, errors, no matches). */
export function QuickPickMessage({ children }: { children: ReactNode }) {
  return <div className="text-muted-foreground px-4 py-8 text-center text-xs">{children}</div>;
}

function getOptions(list: HTMLElement | null): HTMLButtonElement[] {
  return Array.from(list?.querySelectorAll<HTMLButtonElement>("[data-quick-pick-option]") ?? []);
}
