import { LoaderIcon } from "lucide-react";
import * as monaco from "monaco-editor";
import { useCallback, useEffect, useMemo, useState } from "react";

import { HighlightedLabel } from "@/components/ui/HighlightedLabel";
import { PickerDialog, PickerMessage } from "@/components/ui/picker-dialog";
import { abbreviateHomePath } from "@/lib/home-path";
import { getConnectedLspClients } from "@/lib/lsp-client";
import { dispatchOpenFile } from "@/lib/open-file";
import { isWithin } from "@/lib/project-file-helpers";
import { cn } from "@/lib/utils";
import type { WorkspaceSymbolResult } from "@/lib/workspace-symbols";
import {
  resolveWorkspaceSymbolLocation,
  searchWorkspaceSymbols,
  symbolKey,
} from "@/lib/workspace-symbols";
import { useProjectStore } from "@/store/projects";
import { useSymbolSearchStore } from "@/store/symbol-search";
import { useWorktreeStore } from "@/store/worktrees";

import { SymbolKindIcon } from "./SymbolKindIcon";

const DEBOUNCE_MS = 150;
const MAX_VISIBLE = 200;
const RESOLVE_TIMEOUT_MS = 2000;

interface SearchState {
  /** The worktree and trimmed query `results` answer. */
  wtPath: string | null;
  query: string;
  results: WorkspaceSymbolResult[];
  /** Every server has answered or given up. */
  done: boolean;
}

const NO_SEARCH: SearchState = { wtPath: null, query: "", results: [], done: true };
const NO_RESULTS: WorkspaceSymbolResult[] = [];

/**
 * Searches `workspace/symbol` on the active worktree's connected language servers as the query
 * changes, debounced, showing each server's answer as it arrives. A newer query cancels the
 * requests in flight (`$/cancelRequest`).
 */
function useWorkspaceSymbolSearch(isOpen: boolean, wtPath: string | null, query: string) {
  const [state, setState] = useState<SearchState>(NO_SEARCH);
  const trimmed = query.trim();

  // A new session starts empty, so results of an earlier one are never shown or accepted.
  useEffect(() => {
    if (!isOpen) setState(NO_SEARCH);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !wtPath || !trimmed) return;
    const tokens = new monaco.CancellationTokenSource();
    const timer = setTimeout(() => {
      const sources = getConnectedLspClients(wtPath);
      void searchWorkspaceSymbols(sources, trimmed, wtPath, tokens.token, (results, done) =>
        setState({ wtPath, query: trimmed, results, done }),
      );
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      tokens.cancel();
      tokens.dispose();
    };
  }, [isOpen, wtPath, trimmed]);

  if (!trimmed || !wtPath) return { results: NO_RESULTS, searching: false };
  // Keep showing the previous query's answer, in this worktree, while the next one arrives.
  const current = state.wtPath === wtPath;
  return {
    results: current ? state.results : NO_RESULTS,
    searching: !current || state.query !== trimmed || !state.done,
  };
}

function emptyMessage(query: string, searching: boolean): string {
  if (!query.trim()) {
    return "Type a symbol name. Searches the language servers of the files open in this worktree.";
  }
  return searching ? "Searching…" : "No matching symbols";
}

export function SymbolSearchModal() {
  const isOpen = useSymbolSearchStore((s) => s.isOpen);
  const query = useSymbolSearchStore((s) => s.query);
  const close = useSymbolSearchStore((s) => s.close);
  const setQuery = useSymbolSearchStore((s) => s.setQuery);
  const wtPath = useWorktreeStore((s) => s.activeWorktreePath);
  const homeDir = useProjectStore((s) => s.homeDir);

  const { results, searching } = useWorkspaceSymbolSearch(isOpen, wtPath, query);
  const visible = useMemo(() => results.slice(0, MAX_VISIBLE), [results]);

  const openSymbol = useCallback(
    (result: WorkspaceSymbolResult) => {
      close();
      void resolveWorkspaceSymbolLocation(result, RESOLVE_TIMEOUT_MS).then((location) =>
        dispatchOpenFile(result.filePath, location),
      );
    },
    [close],
  );

  const displayPath = (filePath: string) =>
    wtPath && isWithin(filePath, wtPath)
      ? filePath.slice(wtPath.length + 1)
      : abbreviateHomePath(filePath, homeDir);

  return (
    <PickerDialog
      name="Symbol Search"
      isOpen={isOpen}
      onClose={close}
      query={query}
      onQueryChange={setQuery}
      placeholder="Go to symbol in workspace"
      items={visible}
      getKey={symbolKey}
      onAccept={openSymbol}
      itemClassName="py-1.5"
      inputAdornment={
        searching && <LoaderIcon className="text-muted-foreground size-3.5 animate-spin" />
      }
      emptyState={<PickerMessage>{emptyMessage(query, searching)}</PickerMessage>}
      renderItem={({ symbol, filePath, indices }) => (
        <div className="flex items-center gap-2 text-sm">
          <SymbolKindIcon kind={symbol.kind} className="size-4 shrink-0" />
          <span
            className={cn(
              "shrink-0",
              symbol.tags.includes(monaco.languages.SymbolTag.Deprecated) && "line-through",
            )}
          >
            <HighlightedLabel text={symbol.name} indices={indices} />
          </span>
          {symbol.containerName && (
            <span className="text-muted-foreground truncate text-xs">{symbol.containerName}</span>
          )}
          <span className="text-muted-foreground ml-auto truncate pl-4 text-xs" dir="rtl">
            {/* rtl truncates the start of a long path; the bdi keeps its characters in order */}
            <bdi>
              {displayPath(filePath)}
              {symbol.range ? `:${symbol.range.startLineNumber}` : ""}
            </bdi>
          </span>
        </div>
      )}
    />
  );
}
