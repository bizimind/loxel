/**
 * xterm.js link provider that detects file paths in terminal output.
 *
 * Two detection modes:
 * 1. **Prefix-based**: paths starting with `/`, `./`, `../`, or `~/` — always linked.
 * 2. **Bare filenames**: tokens like `CLAUDE.md` or `src/index.ts` without a prefix —
 *    only linked if they match a known project file from the file index.
 *
 * Both modes support optional `:line` or `:line:col` suffixes.
 */
import type { IBufferLine, ILink, ILinkProvider, Terminal } from "@xterm/xterm";

import { dispatchOpenFile, type FileLocation } from "@/lib/open-file";

/** Paths starting with `/`, `./`, `../`, or `~/` — always treated as file links. */
const PREFIXED_PATH_RE = /(?<=^|[\s"'`({[;,|<>])(?:\/|\.\/|\.\.\/|~\/)[^\s"'`(){}[\];,|<>]+/g;

/**
 * Bare file-like tokens: word chars, dots, slashes, hyphens (must contain a dot for extension).
 * Only linked when they match a known project file.
 */
const BARE_FILE_RE =
  /(?<=^|[\s"'`({[;,|<>])[\w][\w./@-]*\.\w+(?::\d+(?::\d+)?)?(?=[\s"'`(){}[\];,|<>]|$)/g;

// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;

/** Strip ANSI escape sequences that may appear in raw buffer text. */
function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, "");
}

/** Parse an optional `:line` or `:line:col` suffix from a path. */
function parseLocationSuffix(raw: string): { path: string; location?: FileLocation } {
  const match = raw.match(/:(\d+)(?::(\d+))?$/);
  if (!match) return { path: raw };
  const line = Number(match[1]);
  if (line === 0) return { path: raw };
  const col = match[2] ? Number(match[2]) : 1;
  return { path: raw.slice(0, match.index!), location: { line, column: col } };
}

/** Resolve `~` to home dir and relative paths against cwd. */
function resolvePath(filePath: string, cwd: string): string {
  if (filePath.startsWith("~/")) {
    // Can't resolve ~ in the browser — leave as-is (server will handle it)
    return filePath;
  }
  if (filePath.startsWith("/")) return filePath;
  // Relative path — resolve against cwd
  return new URL(filePath, `file://${cwd}/`).pathname;
}

/**
 * Map an index in the ANSI-stripped text back to the corresponding index in the raw text.
 * ANSI escape sequences occupy cells in the buffer, so link column ranges must use raw
 * positions, not stripped-text positions.
 */
function strippedToRawIndex(rawText: string, strippedIndex: number): number {
  let rawIdx = 0;
  let strippedCount = 0;

  while (rawIdx < rawText.length) {
    ANSI_ESCAPE_RE.lastIndex = rawIdx;
    const m = ANSI_ESCAPE_RE.exec(rawText);
    if (m && m.index === rawIdx) {
      rawIdx += m[0].length;
      continue;
    }
    if (strippedCount === strippedIndex) break;
    rawIdx++;
    strippedCount++;
  }

  return rawIdx;
}

/** Get the text content of a buffer line. */
function getLineText(line: IBufferLine): string {
  let text = "";
  for (let i = 0; i < line.length; i++) {
    text += line.getCell(i)?.getChars() ?? "";
  }
  return text;
}

/** Index of known project files for bare filename matching. */
export interface FileIndex {
  /** All relative paths from the project root (e.g., "src/index.ts", "CLAUDE.md"). */
  paths: Set<string>;
  /** Basename → relative paths for filename-only matches (e.g., "index.ts" → ["src/index.ts"]). */
  basenames: Map<string, string[]>;
}

/** Build a file index from a list of relative paths. */
export function buildFileIndex(files: string[]): FileIndex {
  const paths = new Set(files);
  const basenames = new Map<string, string[]>();
  for (const file of files) {
    const basename = file.slice(file.lastIndexOf("/") + 1);
    const existing = basenames.get(basename);
    if (existing) {
      existing.push(file);
    } else {
      basenames.set(basename, [file]);
    }
  }
  return { paths, basenames };
}

/**
 * Look up a bare token against the file index.
 * Returns the relative path if found, or undefined.
 */
function lookupBareFile(token: string, index: FileIndex): string | undefined {
  // Direct match (e.g., "src/index.ts" or "CLAUDE.md")
  if (index.paths.has(token)) return token;
  // Basename match (e.g., "index.ts" → first matching path)
  const matches = index.basenames.get(token);
  if (matches && matches.length > 0) return matches[0];
  return undefined;
}

function createLink(
  startCol: number,
  endCol: number,
  bufferLineNumber: number,
  text: string,
  getCwd: () => string | null,
  resolvedRelative?: string,
): ILink {
  return {
    range: { start: { x: startCol, y: bufferLineNumber }, end: { x: endCol, y: bufferLineNumber } },
    text,
    activate(event: MouseEvent, linkText: string) {
      if (!event.metaKey) return;
      const cwd = getCwd();
      if (!cwd) return;

      const { path: filePath, location } = parseLocationSuffix(linkText);
      // For bare filenames resolved via the index, use the worktree root + relative path
      const resolved = resolvedRelative
        ? resolvePath(resolvedRelative, cwd)
        : resolvePath(filePath, cwd);
      dispatchOpenFile(resolved, location);
    },
  };
}

export function createFilePathLinkProvider(
  terminal: Terminal,
  getCwd: () => string | null,
  getFileIndex: () => FileIndex | null,
): ILinkProvider {
  return {
    provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void): void {
      const buffer = terminal.buffer.active;
      const line = buffer.getLine(bufferLineNumber - 1);
      if (!line) {
        callback(undefined);
        return;
      }

      const rawText = getLineText(line);
      const text = stripAnsi(rawText);
      const links: ILink[] = [];

      // Track matched ranges to avoid overlapping links
      const matched = new Set<number>();

      // Pass 1: prefixed paths (always linked)
      for (const match of text.matchAll(PREFIXED_PATH_RE)) {
        let matchText = match[0]!;

        // Strip trailing punctuation but keep `:line:col` suffix
        const suffixMatch = matchText.match(/:(\d+)(?::(\d+))?$/);
        if (suffixMatch) {
          const suffixStart = suffixMatch.index!;
          matchText =
            matchText.slice(0, suffixStart).replace(/[.:,)}\]]+$/, "") +
            matchText.slice(suffixStart);
        } else {
          matchText = matchText.replace(/[.:,)}\]]+$/, "");
        }

        for (let i = match.index!; i < match.index! + matchText.length; i++) matched.add(i);
        const startCol = strippedToRawIndex(rawText, match.index!) + 1;
        const endCol = strippedToRawIndex(rawText, match.index! + matchText.length - 1) + 1;
        links.push(createLink(startCol, endCol, bufferLineNumber, matchText, getCwd));
      }

      // Pass 2: bare filenames (only if file index is available)
      const fileIndex = getFileIndex();
      if (fileIndex) {
        for (const match of text.matchAll(BARE_FILE_RE)) {
          const matchText = match[0]!;
          // Skip if already covered by a prefixed path
          if (matched.has(match.index!)) continue;

          const { path: barePath } = parseLocationSuffix(matchText);
          const relativePath = lookupBareFile(barePath, fileIndex);
          if (!relativePath) continue;

          const startCol = strippedToRawIndex(rawText, match.index!) + 1;
          const endCol = strippedToRawIndex(rawText, match.index! + matchText.length - 1) + 1;
          links.push(
            createLink(startCol, endCol, bufferLineNumber, matchText, getCwd, relativePath),
          );
        }
      }

      callback(links.length > 0 ? links : undefined);
    },
  };
}
