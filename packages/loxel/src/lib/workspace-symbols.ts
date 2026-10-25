import type { MonacoLspClient, WorkspaceSymbolItem } from "@bizimind/monaco-lsp-client";
import * as monaco from "monaco-editor";

import { frontendLog } from "./frontend-logger";
import { fuzzyMatch } from "./fuzzy-match";
import type { FileLocation } from "./open-file";
import { isWithin } from "./project-file-helpers";

const log = frontendLog.child("search");

/** The part of a language-server client a workspace symbol search uses. */
export type WorkspaceSymbolSource = Pick<
  MonacoLspClient,
  "workspaceSymbols" | "resolveWorkspaceSymbol"
>;

export interface WorkspaceSymbolResult {
  symbol: WorkspaceSymbolItem;
  /** The client that returned the symbol, which can resolve its range. */
  source: WorkspaceSymbolSource;
  /** Absolute path of the file holding the symbol. */
  filePath: string;
  /** Indices of the characters of `symbol.name` that match the query. */
  indices: number[];
}

type Candidate = Omit<WorkspaceSymbolResult, "indices">;

/**
 * Queries `workspace/symbol` on every source at once and merges the answers into one ranked
 * list (see `rankWorkspaceSymbols`). A source that fails is logged and left out. Once `token`
 * is cancelled the answers are stale and the result is empty.
 */
export async function searchWorkspaceSymbols(
  sources: readonly WorkspaceSymbolSource[],
  query: string,
  wtPath: string,
  token: monaco.CancellationToken,
): Promise<WorkspaceSymbolResult[]> {
  const answers = await Promise.allSettled(sources.map((s) => s.workspaceSymbols(query, token)));
  if (token.isCancellationRequested) return [];

  const candidates: Candidate[] = [];
  answers.forEach((answer, i) => {
    if (answer.status === "rejected") {
      log.warn("workspace/symbol failed", { error: answer.reason });
      return;
    }
    const source = sources[i]!;
    for (const symbol of answer.value) {
      const filePath = symbolFilePath(symbol.uri);
      if (filePath) candidates.push({ symbol, source, filePath });
    }
  });
  return rankWorkspaceSymbols(query, candidates, wtPath);
}

/**
 * Orders symbols from several servers for display. Each server filters by its own matcher (and
 * Pyright's is loose), so they are re-scored against the name here: exact match, then prefix,
 * substring and subsequence; symbols only a server matched stay, last. Ties put the project's own
 * files before installed packages and the stdlib, then shorter names, then path and line.
 * The same symbol reported twice (two servers covering one file) is kept once.
 */
export function rankWorkspaceSymbols(
  query: string,
  candidates: readonly Candidate[],
  wtPath: string,
): WorkspaceSymbolResult[] {
  const seen = new Set<string>();
  const scored: Array<{ result: WorkspaceSymbolResult; score: number; isProjectFile: boolean }> =
    [];
  for (const candidate of candidates) {
    const { name, kind, range } = candidate.symbol;
    const key = `${candidate.filePath}\0${name}\0${kind}\0${range?.startLineNumber}:${range?.startColumn}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const match = fuzzyMatch(query, name);
    scored.push({
      result: { ...candidate, indices: match?.indices ?? [] },
      score: nameScore(query, name, match?.score ?? 0),
      isProjectFile: isProjectFile(candidate.filePath, wtPath),
    });
  }

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      Number(b.isProjectFile) - Number(a.isProjectFile) ||
      a.result.symbol.name.length - b.result.symbol.name.length ||
      a.result.filePath.localeCompare(b.result.filePath) ||
      (a.result.symbol.range?.startLineNumber ?? 0) - (b.result.symbol.range?.startLineNumber ?? 0),
  );
  return scored.map((s) => s.result);
}

/** `fuzzyMatch`'s tiers (3 prefix, 2 substring, 1 subsequence) with exact matches above them. */
function nameScore(query: string, name: string, fuzzyScore: number): number {
  if (name === query) return 5;
  if (name.toLowerCase() === query.toLowerCase()) return 4;
  return fuzzyScore;
}

/**
 * Where to open a symbol: its range's start, resolving the range through the server first when
 * the symbol came without one. Falls back to the top of the file (undefined) when resolving fails
 * or takes longer than `timeoutMs`, so a stuck server never keeps the file from opening.
 */
export async function resolveWorkspaceSymbolLocation(
  result: WorkspaceSymbolResult,
  timeoutMs: number,
): Promise<FileLocation | undefined> {
  let { range } = result.symbol;
  if (!range) {
    const tokens = new monaco.CancellationTokenSource();
    const timer = setTimeout(() => tokens.cancel(), timeoutMs);
    try {
      ({ range } = await result.source.resolveWorkspaceSymbol(result.symbol, tokens.token));
    } catch (error) {
      log.warn("workspaceSymbol/resolve failed", {
        error,
        timedOut: tokens.token.isCancellationRequested,
      });
    } finally {
      clearTimeout(timer);
      tokens.dispose();
    }
  }
  return range ? { line: range.startLineNumber, column: range.startColumn } : undefined;
}

/** In the worktree and not in an installed package (`node_modules`, a venv's `site-packages`). */
function isProjectFile(filePath: string, wtPath: string): boolean {
  if (!isWithin(filePath, wtPath)) return false;
  const relative = filePath.slice(wtPath.length);
  return !relative.includes("/node_modules/") && !relative.includes("/site-packages/");
}

/**
 * The file path behind a symbol's URI: `file://` for most servers, `loxel://HEAD/` for TypeScript
 * (see LANGUAGE_SERVERS.md). Other schemes cannot be opened in an editor tab.
 */
function symbolFilePath(uri: string): string | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (url.protocol !== "file:" && url.protocol !== "loxel:") return null;
  return decodeURIComponent(url.pathname);
}
