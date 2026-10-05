import { ChevronDownIcon, ChevronUpIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";

/** Match counts reported by a find backend. `active` is 1-based; 0 when no match is selected. */
export interface FindMatches {
  active: number;
  total: number;
}

export interface FindBarProps {
  /** What is being searched, for the input's accessible label ("Find in page"). */
  label: string;
  query: string;
  matches: FindMatches | null;
  /** Incremented to focus the input and select its text (⌘F while the bar is open). */
  focusRequest: number;
  onQueryChange: (query: string) => void;
  onNext: () => void;
  onPrevious: () => void;
  onClose: () => void;
}

/** Floating find bar shown at the top right of a panel (browser page, terminal). */
export function FindBar({
  label,
  query,
  matches,
  focusRequest,
  onQueryChange,
  onNext,
  onPrevious,
  onClose,
}: FindBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusRequest]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (e.shiftKey) onPrevious();
        else onNext();
      }
    },
    [onClose, onNext, onPrevious],
  );

  return (
    <div className="border-border bg-editor-surface absolute top-2 right-2 z-10 flex items-center gap-1 rounded-md border px-2 py-1 shadow-md">
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Find"
        aria-label={label}
        spellCheck={false}
        className="border-border text-foreground placeholder:text-muted-foreground h-6 w-48 rounded border bg-transparent px-2 text-xs focus:outline-none"
      />
      {query && (
        <span className="text-muted-foreground px-1 text-xs tabular-nums">
          {formatMatches(matches)}
        </span>
      )}
      <FindBarButton onClick={onPrevious} title="Previous match (⇧⏎)">
        <ChevronUpIcon className="size-3.5" />
      </FindBarButton>
      <FindBarButton onClick={onNext} title="Next match (⏎)">
        <ChevronDownIcon className="size-3.5" />
      </FindBarButton>
      <FindBarButton onClick={onClose} title="Close (Esc)">
        <XIcon className="size-3.5" />
      </FindBarButton>
    </div>
  );
}

function formatMatches(matches: FindMatches | null): string {
  if (!matches) return "";
  if (matches.total === 0) return "No results";
  return `${matches.active > 0 ? matches.active : "?"} of ${matches.total}`;
}

function FindBarButton({
  onClick,
  title,
  children,
}: {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className="text-muted-foreground hover:text-foreground hover:bg-muted flex size-6 cursor-pointer items-center justify-center rounded"
    >
      {children}
    </button>
  );
}
