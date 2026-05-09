import { LoaderIcon, SearchIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";

import * as api from "@/api/client";
import { HighlightedLabel } from "@/components/ui/HighlightedLabel";
import { ModalErrorBoundary } from "@/components/ui/modal-error-boundary";
import { FileTypeIcon } from "@/lib/file-icons";
import { frontendLog } from "@/lib/frontend-logger";
import { type FuzzyResult, fuzzyMatchPath } from "@/lib/fuzzy-match";
import { dispatchLoxelEvent } from "@/lib/loxel-events";
import { dispatchOpenFile, parseQueryLocation } from "@/lib/open-file";
import { cn } from "@/lib/utils";
import { useFileSearchStore } from "@/store/file-search";
import { useWorktreeStore } from "@/store/worktrees";

const log = frontendLog.child("search");
const MAX_VISIBLE = 200;
const MRU_DISPLAY_LIMIT = 15;
const EMPTY_QUERY_LIMIT = 50;

export function FileSearchModal() {
  const isOpen = useFileSearchStore((s) => s.isOpen);
  const query = useFileSearchStore((s) => s.query);
  const loading = useFileSearchStore((s) => s.loading);
  const error = useFileSearchStore((s) => s.error);
  const indexByWorktree = useFileSearchStore((s) => s.indexByWorktree);
  const mruByWorktree = useFileSearchStore((s) => s.mruByWorktree);

  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const activeWorktreePath = useWorktreeStore((s) => s.activeWorktreePath);
  const entry = activeWorktreePath ? indexByWorktree.get(activeWorktreePath) : undefined;
  const files = entry?.files;
  const truncated = entry?.truncated ?? false;
  const mru = activeWorktreePath ? mruByWorktree.get(activeWorktreePath) : undefined;

  // Parse go-to-line suffix from query
  const { search: searchQuery, location: queryLocation } = useMemo(
    () => parseQueryLocation(query.trim()),
    [query],
  );

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

  // Fetch file index on open — always re-fetch in background, show cached data immediately
  useEffect(() => {
    if (!isOpen || !activeWorktreePath) return;

    const store = useFileSearchStore.getState();
    if (!store.indexByWorktree.has(activeWorktreePath)) {
      store.setLoading(true);
    }

    let cancelled = false;
    api
      .getFileIndex(activeWorktreePath)
      .then((res) => {
        if (!cancelled) {
          useFileSearchStore.getState().setFiles(activeWorktreePath, res.files, res.truncated);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          log.warn("Failed to fetch file index", { error: err });
          const s = useFileSearchStore.getState();
          s.setLoading(false);
          if (!s.indexByWorktree.has(activeWorktreePath)) {
            s.setError(true);
          }
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, activeWorktreePath]);

  // Fuzzy filter results
  const filtered = useMemo(() => {
    if (!files) return [];
    const q = searchQuery;
    if (!q) {
      // Empty query: show MRU first, then alphabetical, deduped
      const fileSet = new Set(files);
      const mruValid = (mru ?? []).filter((p) => fileSet.has(p));
      const mruSet = new Set(mruValid);
      const rest = files
        .filter((f) => !mruSet.has(f))
        .slice(0, EMPTY_QUERY_LIMIT - mruValid.length);
      return [...mruValid.slice(0, MRU_DISPLAY_LIMIT), ...rest].map((f) => ({
        path: f,
        indices: [] as number[],
        score: 0,
      }));
    }

    const matches: Array<FuzzyResult & { path: string; tiebreaker: number }> = [];
    for (const f of files) {
      const result = fuzzyMatchPath(q, f);
      if (result)
        matches.push({
          path: f,
          indices: result.indices,
          score: result.score,
          tiebreaker: result.tiebreaker,
        });
    }

    matches.sort((a, b) => b.score - a.score || a.tiebreaker - b.tiebreaker);
    return matches.slice(0, MAX_VISIBLE);
  }, [files, searchQuery, mru]);

  // Focus first result when filtered results change
  useEffect(() => {
    if (filtered.length === 0) return;
    if (document.activeElement === inputRef.current) return;
    const first = listRef.current?.querySelector<HTMLElement>("[data-file-option]");
    first?.focus();
  }, [filtered]);

  const close = useFileSearchStore((s) => s.close);

  const openFile = useCallback(
    (path: string) => {
      if (!activeWorktreePath) return;
      useFileSearchStore.getState().recordOpen(activeWorktreePath, path);
      const absPath = activeWorktreePath + "/" + path;
      dispatchOpenFile(absPath, queryLocation);
      dispatchLoxelEvent("loxel-reveal-in-explorer", { filePath: absPath });
      close();
    },
    [activeWorktreePath, queryLocation, close],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const items = listRef.current?.querySelectorAll<HTMLButtonElement>("[data-file-option]");
        if (!items?.length) return;

        const active = document.activeElement;
        const optionArray = Array.from(items);
        const currentIdx = active instanceof HTMLButtonElement ? optionArray.indexOf(active) : -1;

        if (e.key === "ArrowDown") {
          const next = currentIdx < 0 ? 0 : Math.min(currentIdx + 1, optionArray.length - 1);
          optionArray[next]?.focus();
          optionArray[next]?.scrollIntoView({ block: "nearest" });
        } else if (currentIdx <= 0) {
          inputRef.current?.focus();
        } else {
          optionArray[currentIdx - 1]?.focus();
          optionArray[currentIdx - 1]?.scrollIntoView({ block: "nearest" });
        }
        return;
      }

      if (e.key === "Enter") {
        e.preventDefault();
        // If a file option is focused, open it
        const focused = document.activeElement;
        const path = focused instanceof HTMLElement ? focused.dataset.filePath : undefined;
        if (path) {
          openFile(path);
          return;
        }
        // If input is focused, open the first result
        const first = listRef.current?.querySelector<HTMLElement>("[data-file-option]");
        const firstPath = first?.dataset?.filePath;
        if (firstPath) openFile(firstPath);
        return;
      }

      // Forward typing to input when a file option is focused
      if (
        document.activeElement !== inputRef.current &&
        document.activeElement !== dialogRef.current
      ) {
        // Cmd+A: focus input and select all text
        if (e.key === "a" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          inputRef.current?.focus();
          inputRef.current?.select();
          return;
        }
        if (e.key === "Backspace") {
          e.preventDefault();
          const store = useFileSearchStore.getState();
          store.setQuery(store.query.slice(0, -1));
          inputRef.current?.focus();
          return;
        }
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
          e.preventDefault();
          const store = useFileSearchStore.getState();
          store.setQuery(store.query + e.key);
          inputRef.current?.focus();
        }
      }
    },
    [openFile],
  );

  return createPortal(
    <ModalErrorBoundary name="File Search" onClose={close}>
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
          {/* Search input */}
          <div className="border-border flex items-center gap-1 border-b px-2 py-2.5">
            <SearchIcon className="text-muted-foreground size-4 shrink-0" />
            <input
              ref={inputRef}
              type="text"
              className="text-foreground placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-sm outline-none"
              placeholder="Open file"
              value={query}
              onChange={(e) => useFileSearchStore.getState().setQuery(e.target.value)}
            />
            {loading && <LoaderIcon className="text-muted-foreground size-3.5 animate-spin" />}
            {queryLocation && (
              <span className="text-muted-foreground shrink-0 text-[11px]">
                :{queryLocation.line}
                {queryLocation.column !== 1 ? `:${queryLocation.column}` : ""}
              </span>
            )}
          </div>

          {/* Results */}
          <div ref={listRef} className="max-h-[50vh] overflow-y-auto">
            {loading && !files && (
              <div className="text-muted-foreground px-4 py-8 text-center text-xs">
                Loading files...
              </div>
            )}
            {!loading && !files && error && (
              <div className="text-muted-foreground px-4 py-8 text-center text-xs">
                Failed to load files — please try again
              </div>
            )}
            {files && filtered.length === 0 && searchQuery && (
              <div className="text-muted-foreground px-4 py-8 text-center text-xs">
                No matching files
              </div>
            )}
            {filtered.map((match) => {
              const lastSlash = match.path.lastIndexOf("/");
              const dir = lastSlash === -1 ? "" : match.path.slice(0, lastSlash + 1);
              const filename = lastSlash === -1 ? match.path : match.path.slice(lastSlash + 1);

              return (
                <button
                  type="button"
                  key={match.path}
                  data-file-option
                  data-file-path={match.path}
                  className={cn(
                    "border-border/50 w-full border-b px-3 py-1.5 text-left transition-colors outline-none last:border-b-0",
                    "hover:bg-primary/50 focus:bg-primary",
                  )}
                  onClick={() => openFile(match.path)}
                >
                  <div className="flex items-center gap-2 truncate text-sm">
                    <FileTypeIcon filename={filename} className="size-4 shrink-0" />
                    {searchQuery ? (
                      <span className="truncate">
                        <HighlightedLabel text={match.path} indices={match.indices} />
                      </span>
                    ) : (
                      <span className="truncate">
                        <span className="text-muted-foreground">{dir}</span>
                        <span className="text-foreground">{filename}</span>
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Footer */}
          {truncated && (
            <div className="border-border text-muted-foreground border-t px-3 py-1.5 text-center text-[11px]">
              File list truncated — not all files are shown
            </div>
          )}
        </div>
      </dialog>
    </ModalErrorBoundary>,
    document.body,
  );
}
