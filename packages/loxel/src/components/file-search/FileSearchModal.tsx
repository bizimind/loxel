import { LoaderIcon } from "lucide-react";
import { useCallback, useEffect, useMemo } from "react";

import * as api from "@/api/client";
import { HighlightedLabel } from "@/components/ui/HighlightedLabel";
import { QuickPick, QuickPickMessage } from "@/components/ui/quick-pick";
import { FileTypeIcon } from "@/lib/file-icons";
import { frontendLog } from "@/lib/frontend-logger";
import { type FuzzyResult, fuzzyMatchPath } from "@/lib/fuzzy-match";
import { dispatchLoxelEvent } from "@/lib/loxel-events";
import { dispatchOpenFile, parseQueryLocation } from "@/lib/open-file";
import { useFileSearchStore } from "@/store/file-search";
import { useWorktreeStore } from "@/store/worktrees";

const log = frontendLog.child("search");
const MAX_VISIBLE = 200;
const MRU_DISPLAY_LIMIT = 15;
const EMPTY_QUERY_LIMIT = 50;

interface FileMatch {
  /** Relative to the worktree. */
  path: string;
  indices: number[];
}

export function FileSearchModal() {
  const isOpen = useFileSearchStore((s) => s.isOpen);
  const query = useFileSearchStore((s) => s.query);
  const loading = useFileSearchStore((s) => s.loading);
  const error = useFileSearchStore((s) => s.error);
  const indexByWorktree = useFileSearchStore((s) => s.indexByWorktree);
  const mruByWorktree = useFileSearchStore((s) => s.mruByWorktree);

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
  const filtered = useMemo((): FileMatch[] => {
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
        indices: [],
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

  const close = useFileSearchStore((s) => s.close);
  const setQuery = useFileSearchStore((s) => s.setQuery);

  const openFile = useCallback(
    ({ path }: FileMatch) => {
      if (!activeWorktreePath) return;
      useFileSearchStore.getState().recordOpen(activeWorktreePath, path);
      const absPath = activeWorktreePath + "/" + path;
      dispatchOpenFile(absPath, queryLocation);
      dispatchLoxelEvent("loxel-reveal-in-explorer", { filePath: absPath });
      close();
    },
    [activeWorktreePath, queryLocation, close],
  );

  return (
    <QuickPick
      name="File Search"
      isOpen={isOpen}
      onClose={close}
      query={query}
      onQueryChange={setQuery}
      placeholder="Open file"
      items={filtered}
      getKey={(match) => match.path}
      onAccept={openFile}
      itemClassName="py-1.5"
      inputAdornment={
        <>
          {loading && <LoaderIcon className="text-muted-foreground size-3.5 animate-spin" />}
          {queryLocation && (
            <span className="text-muted-foreground shrink-0 text-[11px]">
              :{queryLocation.line}
              {queryLocation.column !== 1 ? `:${queryLocation.column}` : ""}
            </span>
          )}
        </>
      }
      emptyState={
        <>
          {loading && !files && <QuickPickMessage>Loading files...</QuickPickMessage>}
          {!loading && !files && error && (
            <QuickPickMessage>Failed to load files — please try again</QuickPickMessage>
          )}
          {files && searchQuery && <QuickPickMessage>No matching files</QuickPickMessage>}
        </>
      }
      renderItem={(match) => {
        const lastSlash = match.path.lastIndexOf("/");
        const dir = lastSlash === -1 ? "" : match.path.slice(0, lastSlash + 1);
        const filename = lastSlash === -1 ? match.path : match.path.slice(lastSlash + 1);
        return (
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
        );
      }}
      footer={
        truncated && (
          <div className="border-border text-muted-foreground border-t px-3 py-1.5 text-center text-[11px]">
            File list truncated — not all files are shown
          </div>
        )
      }
    />
  );
}
