import { LoaderIcon } from "lucide-react";
import * as monaco from "monaco-editor";
import { useCallback, useEffect, useState } from "react";

import { HighlightedLabel } from "@/components/ui/HighlightedLabel";
import { QuickPick, QuickPickMessage } from "@/components/ui/quick-pick";
import { abbreviateHomePath } from "@/lib/home-path";
import { getConnectedLspClients } from "@/lib/lsp-client";
import { dispatchOpenFile } from "@/lib/open-file";
import { isWithin } from "@/lib/project-file-helpers";
import type { WorkspaceSymbolResult } from "@/lib/workspace-symbols";
import { resolveWorkspaceSymbolLocation, searchWorkspaceSymbols } from "@/lib/workspace-symbols";
import { useProjectStore } from "@/store/projects";
import { useSymbolSearchStore } from "@/store/symbol-search";
import { useWorktreeStore } from "@/store/worktrees";

import { SymbolKindIcon } from "./SymbolKindIcon";

const DEBOUNCE_MS = 150;
const MAX_VISIBLE = 200;
const RESOLVE_TIMEOUT_MS = 2000;

interface SearchState {
  /** The trimmed query `results` answer. */
  query: string;
  results: WorkspaceSymbolResult[];
}

/**
 * Searches `workspace/symbol` on the active worktree's connected language servers as the query
 * changes, debounced. A newer query cancels the request in flight (`$/cancelRequest`).
 */
function useWorkspaceSymbolSearch(isOpen: boolean, wtPath: string | null, query: string) {
  const [state, setState] = useState<SearchState>({ query: "", results: [] });
  const trimmed = query.trim();

  useEffect(() => {
    if (!isOpen || !wtPath || !trimmed) return;
    const tokens = new monaco.CancellationTokenSource();
    const timer = setTimeout(() => {
      void searchWorkspaceSymbols(
        getConnectedLspClients(wtPath),
        trimmed,
        wtPath,
        tokens.token,
      ).then((results) => {
        if (!tokens.token.isCancellationRequested) setState({ query: trimmed, results });
      });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      tokens.cancel();
      tokens.dispose();
    };
  }, [isOpen, wtPath, trimmed]);

  if (!trimmed) return { results: [], searching: false };
  // Keep showing the previous answer while the next one is on its way.
  return { results: state.results, searching: state.query !== trimmed };
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
  const visible = results.slice(0, MAX_VISIBLE);

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
    <QuickPick
      name="Symbol Search"
      isOpen={isOpen}
      onClose={close}
      query={query}
      onQueryChange={setQuery}
      placeholder="Go to symbol in workspace"
      items={visible}
      getKey={({ filePath, symbol }) =>
        `${filePath}:${symbol.range?.startLineNumber}:${symbol.range?.startColumn}:${symbol.kind}:${symbol.name}`
      }
      onAccept={openSymbol}
      itemClassName="py-1.5"
      inputAdornment={
        searching && <LoaderIcon className="text-muted-foreground size-3.5 animate-spin" />
      }
      emptyState={<QuickPickMessage>{emptyMessage(query, searching)}</QuickPickMessage>}
      renderItem={({ symbol, filePath, indices }) => (
        <div className="flex items-center gap-2 text-sm">
          <SymbolKindIcon kind={symbol.kind} className="size-4 shrink-0" />
          <span className="shrink-0">
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
