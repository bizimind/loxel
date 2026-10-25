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

/** How long one server may take to answer before it is cancelled and left out of a search. */
const SOURCE_TIMEOUT_MS = 3000;

/**
 * Queries `workspace/symbol` on every source at once. Each time a source answers, `onResults`
 * receives everything merged so far (see `rankWorkspaceSymbols`), so a slow server does not hold
 * back the others; `done` is true on the last call. A source that fails, or has not answered
 * after `timeoutMs`, is cancelled and left out. Nothing is reported once `token` is cancelled.
 */
export async function searchWorkspaceSymbols(
  sources: readonly WorkspaceSymbolSource[],
  query: string,
  wtPath: string,
  token: monaco.CancellationToken,
  onResults: (results: WorkspaceSymbolResult[], done: boolean) => void,
  timeoutMs = SOURCE_TIMEOUT_MS,
): Promise<void> {
  if (sources.length === 0) {
    onResults([], true);
    return;
  }
  const candidates: Candidate[] = [];
  let pending = sources.length;
  await Promise.all(
    sources.map(async (source) => {
      const symbols = await querySource(source, query, token, timeoutMs);
      pending -= 1;
      if (token.isCancellationRequested) return;
      for (const symbol of symbols) {
        const filePath = symbolFilePath(symbol.uri);
        if (filePath) candidates.push({ symbol, source, filePath });
      }
      onResults(rankWorkspaceSymbols(query, candidates, wtPath), pending === 0);
    }),
  );
}

/** The last failure logged per source, so a server that keeps failing logs once, not per keystroke. */
const lastFailure = new WeakMap<WorkspaceSymbolSource, string>();

async function querySource(
  source: WorkspaceSymbolSource,
  query: string,
  token: monaco.CancellationToken,
  timeoutMs: number,
): Promise<WorkspaceSymbolItem[]> {
  const tokens = new monaco.CancellationTokenSource(token);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    tokens.cancel();
  }, timeoutMs);
  try {
    const symbols = await source.workspaceSymbols(query, tokens.token);
    lastFailure.delete(source);
    return symbols;
  } catch (error) {
    if (token.isCancellationRequested) return [];
    const message = timedOut ? "timed out" : String(error);
    if (lastFailure.get(source) !== message) {
      lastFailure.set(source, message);
      log.warn("workspace/symbol failed", { error, timedOut });
    }
    return [];
  } finally {
    clearTimeout(timer);
    tokens.dispose();
  }
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
    const key = symbolKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);

    const { name } = candidate.symbol;
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

/**
 * Identifies a symbol across servers. The container tells apart same-named symbols of one file
 * that come without a range (left to `workspaceSymbol/resolve`).
 */
export function symbolKey({
  filePath,
  symbol,
}: Pick<WorkspaceSymbolResult, "filePath" | "symbol">): string {
  const { name, kind, containerName, range } = symbol;
  return [filePath, name, kind, containerName, range?.startLineNumber, range?.startColumn].join(
    "\0",
  );
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
  try {
    const url = new URL(uri);
    if (url.protocol !== "file:" && url.protocol !== "loxel:") return null;
    return decodeURIComponent(url.pathname);
  } catch {
    // Not a URI, or a malformed percent escape.
    return null;
  }
}
