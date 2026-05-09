import { CaseSensitiveIcon, LoaderIcon, RegexIcon, SearchIcon, WholeWordIcon } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

import * as api from "@/api/client";
import { ModalErrorBoundary } from "@/components/ui/modal-error-boundary";
import { getDisplayFilename } from "@/lib/detached-path";
import { FileTypeIcon } from "@/lib/file-icons";
import { frontendLog } from "@/lib/frontend-logger";
import { dispatchLoxelEvent } from "@/lib/loxel-events";
import { dispatchOpenFile } from "@/lib/open-file";
import { cn } from "@/lib/utils";
import { scopesKey, useSearchStore } from "@/store/search";
import { useWorktreeStore } from "@/store/worktrees";

import { deriveScopeParams } from "./search-scope-model";
import { SearchScopeFilter } from "./SearchScopeFilter";

const log = frontendLog.child("search");
const DEBOUNCE_MS = 300;
const MAX_VISIBLE = 200;

export function SearchModal() {
  const isOpen = useSearchStore((s) => s.isOpen);
  const query = useSearchStore((s) => s.query);
  const regex = useSearchStore((s) => s.regex);
  const caseSensitive = useSearchStore((s) => s.caseSensitive);
  const wholeWord = useSearchStore((s) => s.wholeWord);
  const results = useSearchStore((s) => s.results);
  const truncated = useSearchStore((s) => s.truncated);
  const selectedIndex = useSearchStore((s) => s.selectedIndex);
  const loading = useSearchStore((s) => s.loading);
  const scopes = useSearchStore((s) => s.scopes);

  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const activeWorktreePath = useWorktreeStore((s) => s.activeWorktreePath);

  const currentScopesKey = scopesKey(scopes);

  // Open/close the native dialog
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

  // Fetch available packages and dirs once per worktree (not every modal open)
  const availableDirs = useSearchStore((s) => s.availableDirs) ?? [];
  const fetchedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isOpen || !activeWorktreePath) return;
    if (fetchedForRef.current === activeWorktreePath && availableDirs.length > 0) return;
    fetchedForRef.current = activeWorktreePath;
    api
      .getSearchScopes(activeWorktreePath)
      .then((res) => {
        const store = useSearchStore.getState();
        store.setAvailablePackages(res.packages);
        store.setAvailableDirs(res.dirs);
        store.setAvailableExtensions(res.extensions);
      })
      .catch((err) => {
        log.warn("Failed to fetch search scopes", { error: err });
      });
  }, [isOpen, activeWorktreePath, availableDirs.length]);

  // Debounced search
  useEffect(() => {
    if (!isOpen || !query.trim() || !activeWorktreePath) {
      if (!query.trim()) {
        useSearchStore.getState().setLoading(false);
        useSearchStore.getState().setResults([], false);
      }
      return;
    }

    useSearchStore.getState().setLoading(true);

    // Abort previous in-flight request
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const { scope, paths, globs } = deriveScopeParams(scopes);

    const timer = setTimeout(() => {
      api
        .search(
          activeWorktreePath,
          { q: query, regex, caseSensitive, wholeWord, scope, paths, globs },
          controller.signal,
        )
        .then((res) => {
          if (!controller.signal.aborted) {
            useSearchStore.getState().setResults(res.matches, res.truncated);
          }
        })
        .catch((err) => {
          if (err instanceof DOMException && err.name === "AbortError") {
            useSearchStore.getState().setLoading(false);
            return;
          }
          if (!controller.signal.aborted) {
            useSearchStore.getState().setResults([], false);
          }
        });
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [isOpen, query, regex, caseSensitive, wholeWord, activeWorktreePath, currentScopesKey]);

  const close = useSearchStore((s) => s.close);

  const openResult = useCallback(
    (index: number) => {
      const match = results[index];
      if (!match) return;
      dispatchOpenFile(match.filePath, { line: match.line, column: match.column });
      dispatchLoxelEvent("loxel-reveal-in-explorer", { filePath: match.filePath });
      close();
    },
    [results, close],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const store = useSearchStore.getState();
      if (e.key === "ArrowDown") {
        e.preventDefault();
        const next = Math.min(store.selectedIndex + 1, Math.min(results.length, MAX_VISIBLE) - 1);
        store.setSelectedIndex(next);
        scrollIntoView(next);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const prev = Math.max(store.selectedIndex - 1, 0);
        store.setSelectedIndex(prev);
        scrollIntoView(prev);
      } else if (e.key === "Enter") {
        e.preventDefault();
        openResult(store.selectedIndex);
      }
    },
    [results.length, openResult],
  );

  const scrollIntoView = (index: number) => {
    const list = listRef.current;
    if (!list) return;
    const item = list.children[index] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  };

  const relativePath = useCallback(
    (filePath: string) => {
      if (activeWorktreePath && filePath.startsWith(activeWorktreePath + "/")) {
        return filePath.slice(activeWorktreePath.length + 1);
      }
      return filePath;
    },
    [activeWorktreePath],
  );

  const visibleResults = results.slice(0, MAX_VISIBLE);

  return createPortal(
    <ModalErrorBoundary name="Search" onClose={close}>
      <dialog
        ref={dialogRef}
        className="bg-popover border-border mx-auto mt-[15vh] mb-auto w-[600px] max-w-[90vw] overflow-visible rounded-lg border p-0 shadow-2xl backdrop:bg-black/50"
        onClose={close}
        onClick={(e) => {
          if (e.target === e.currentTarget) close();
        }}
        onKeyDown={handleKeyDown}
      >
        <div className="flex flex-col">
          {/* Search input row */}
          <div className="border-border flex items-center gap-1 border-b px-2 py-1.5">
            <SearchIcon className="text-muted-foreground size-4 shrink-0" />
            <input
              ref={inputRef}
              type="text"
              className="text-foreground placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-sm outline-none"
              placeholder="Search in files..."
              value={query}
              onChange={(e) => useSearchStore.getState().setQuery(e.target.value)}
            />
            {loading && <LoaderIcon className="text-muted-foreground size-3.5 animate-spin" />}
            <button
              type="button"
              className={cn(
                "rounded p-1 transition-colors",
                caseSensitive
                  ? "bg-primary/20 text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => useSearchStore.getState().toggleCaseSensitive()}
              title="Match case"
            >
              <CaseSensitiveIcon className="size-4.5" />
            </button>
            <button
              type="button"
              className={cn(
                "rounded p-1 transition-colors",
                wholeWord
                  ? "bg-primary/20 text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => useSearchStore.getState().toggleWholeWord()}
              title="Match whole word"
            >
              <WholeWordIcon className="size-4.5" />
            </button>
            <button
              type="button"
              className={cn(
                "rounded p-1 transition-colors",
                regex
                  ? "bg-primary/20 text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => useSearchStore.getState().toggleRegex()}
              title="Use regex"
            >
              <RegexIcon className="size-4.5" />
            </button>
          </div>

          {/* Scope filter */}
          <SearchScopeFilter searchInputRef={inputRef} />

          {/* Results */}
          <div ref={listRef} className="max-h-[50vh] overflow-y-auto">
            {!query.trim() && (
              <div className="text-muted-foreground px-4 py-8 text-center text-xs">
                Type to search across files...
              </div>
            )}
            {query.trim() && !loading && results.length === 0 && (
              <div className="text-muted-foreground px-4 py-8 text-center text-xs">
                No results found
              </div>
            )}
            {visibleResults.map((match, i) => (
              <button
                type="button"
                key={`${match.filePath}:${match.line}:${match.column}:${i}`}
                className={cn(
                  "border-border/50 w-full border-b px-3 py-1.5 text-left transition-colors last:border-b-0",
                  i === selectedIndex ? "bg-primary/10" : "hover:bg-muted/50",
                )}
                onClick={() => openResult(i)}
                onMouseEnter={() => useSearchStore.getState().setSelectedIndex(i)}
              >
                <div className="truncate font-mono text-xs leading-5">
                  <HighlightedLine
                    text={match.lineText}
                    matchStart={match.matchStart}
                    matchEnd={match.matchEnd}
                  />
                </div>
                <div className="text-muted-foreground flex items-center gap-1.5 truncate text-[11px] leading-4">
                  <FileTypeIcon
                    filename={getDisplayFilename(match.filePath)}
                    className="size-3.5 shrink-0"
                  />
                  <span className="truncate">
                    {relativePath(match.filePath)}:{match.line}:{match.column}
                  </span>
                </div>
              </button>
            ))}
          </div>

          {/* Footer */}
          {(truncated || results.length > MAX_VISIBLE) && (
            <div className="border-border text-muted-foreground border-t px-3 py-1.5 text-center text-[11px]">
              {truncated
                ? `Showing first ${results.length} results — refine your query for more`
                : `Showing ${MAX_VISIBLE} of ${results.length} results`}
            </div>
          )}
        </div>
      </dialog>
    </ModalErrorBoundary>,
    document.body,
  );
}

function HighlightedLine({
  text,
  matchStart,
  matchEnd,
}: {
  text: string;
  matchStart: number;
  matchEnd: number;
}) {
  const before = text.slice(0, matchStart);
  const match = text.slice(matchStart, matchEnd);
  const after = text.slice(matchEnd);

  return (
    <>
      <span className="text-muted-foreground">{before}</span>
      <mark className="text-foreground rounded-sm bg-yellow-500/30 font-medium">{match}</mark>
      <span className="text-muted-foreground">{after}</span>
    </>
  );
}
