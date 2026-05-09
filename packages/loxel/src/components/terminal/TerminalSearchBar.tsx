import type { SearchAddon } from "@xterm/addon-search";

import { useCallback, useEffect, useRef, useState } from "react";

import { SEARCH_DECORATIONS } from "./search-decorations";

interface TerminalSearchBarProps {
  searchAddon: SearchAddon;
  onClose: () => void;
  onSearchTermChange: (term: string) => void;
}

export function TerminalSearchBar({
  searchAddon,
  onClose,
  onSearchTermChange,
}: TerminalSearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [term, setTerm] = useState("");
  const [resultIndex, setResultIndex] = useState(-1);
  const [resultCount, setResultCount] = useState(0);

  // Track results
  useEffect(() => {
    const disposable = searchAddon.onDidChangeResults((e) => {
      setResultIndex(e.resultIndex);
      setResultCount(e.resultCount);
    });
    return () => disposable.dispose();
  }, [searchAddon]);

  // Autofocus on mount
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const findNext = useCallback(() => {
    if (term) {
      searchAddon.findNext(term, { decorations: SEARCH_DECORATIONS });
    }
  }, [searchAddon, term]);

  const findPrevious = useCallback(() => {
    if (term) {
      searchAddon.findPrevious(term, { decorations: SEARCH_DECORATIONS });
    }
  }, [searchAddon, term]);

  const close = useCallback(() => {
    searchAddon.clearDecorations();
    onClose();
  }, [searchAddon, onClose]);

  const handleInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value;
      setTerm(value);
      onSearchTermChange(value);
      if (value) {
        searchAddon.findNext(value, { incremental: true, decorations: SEARCH_DECORATIONS });
      } else {
        searchAddon.clearDecorations();
        setResultIndex(-1);
        setResultCount(0);
      }
    },
    [searchAddon, onSearchTermChange],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      } else if (e.key === "Enter" && e.shiftKey) {
        e.preventDefault();
        findPrevious();
      } else if (e.key === "Enter") {
        e.preventDefault();
        findNext();
      }
    },
    [close, findNext, findPrevious],
  );

  const resultLabel =
    resultCount > 0
      ? `${resultIndex >= 0 ? resultIndex + 1 : "?"} of ${resultCount}`
      : term
        ? "No results"
        : "";

  return (
    <div className="absolute top-2 right-2 z-10 flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--editor-surface)] px-2 py-1 shadow-md">
      <input
        ref={inputRef}
        value={term}
        onChange={handleInput}
        onKeyDown={handleKeyDown}
        placeholder="Find"
        aria-label="Find in terminal"
        className="h-6 w-48 rounded border border-[var(--border)] bg-transparent px-2 text-xs text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:outline-none"
      />
      {resultLabel && (
        <span className="px-1 text-xs text-[var(--muted-foreground)]">{resultLabel}</span>
      )}
      <button
        type="button"
        onClick={findPrevious}
        title="Previous (Shift+Enter)"
        aria-label="Previous match"
        className="hover:bg-primary/50 flex h-6 w-6 items-center justify-center rounded text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <path d="M2 8L6 4L10 8" />
        </svg>
      </button>
      <button
        type="button"
        onClick={findNext}
        title="Next (Enter)"
        aria-label="Next match"
        className="hover:bg-primary/50 flex h-6 w-6 items-center justify-center rounded text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <path d="M2 4L6 8L10 4" />
        </svg>
      </button>
      <button
        type="button"
        onClick={close}
        title="Close (Escape)"
        aria-label="Close search"
        className="hover:bg-primary/50 flex h-6 w-6 items-center justify-center rounded text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <path d="M2 2L10 10M10 2L2 10" />
        </svg>
      </button>
    </div>
  );
}
