import type { ContentAnchor } from "@/api/comment-model";

export type AnchorStatus = "exact" | "relocated" | "outdated" | "lost";

export type RelocatedAnchor =
  | { status: "exact" | "relocated" | "outdated"; startLine: number; endLine: number }
  | { status: "lost"; startLine: null; endLine: null };

const CONTEXT_LINES = 3;
const SEARCH_RADIUS = 20;
/** Max search radius for context-based fuzzy matching (steps 4-5) */
const CONTEXT_SEARCH_RADIUS = 100;

/**
 * Simple FNV-1a hash for content fingerprinting (browser-compatible).
 * Not cryptographic — just a fast, deterministic fingerprint.
 */
function fnv1aHash(str: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // Convert to 8-char hex string (unsigned)
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Create a content anchor from file lines at the given 1-indexed range.
 */
export function createContentAnchor(
  lines: string[],
  startLine: number,
  endLine: number,
): ContentAnchor {
  const start = startLine - 1; // to 0-indexed
  const end = endLine; // exclusive

  const content = lines.slice(start, end);
  const contextBefore = lines.slice(Math.max(0, start - CONTEXT_LINES), start);
  const contextAfter = lines.slice(end, end + CONTEXT_LINES);
  const contentHash = fnv1aHash(content.join("\n"));

  return { content, contextBefore, contextAfter, contentHash };
}

/**
 * Relocate a content anchor within the current file lines.
 * Returns the best-guess position and a status indicating how confident the match is.
 */
export function relocateAnchor(
  anchor: ContentAnchor,
  currentLines: string[],
  storedStart: number,
): RelocatedAnchor {
  const contentLen = anchor.content.length;
  const storedIdx = storedStart - 1; // 0-indexed

  // 1. Exact content match at stored position
  if (matchesContentAt(anchor.content, currentLines, storedIdx)) {
    return { status: "exact", startLine: storedStart, endLine: storedStart + contentLen - 1 };
  }

  // 2. Exact content match within ±SEARCH_RADIUS lines
  const nearMatch = findContentMatch(anchor.content, currentLines, storedIdx, SEARCH_RADIUS);
  if (nearMatch !== null) {
    return { status: "relocated", startLine: nearMatch + 1, endLine: nearMatch + contentLen };
  }

  // 3. Exact content match anywhere in file
  const globalMatch = findContentMatch(anchor.content, currentLines, 0, currentLines.length);
  if (globalMatch !== null) {
    return { status: "relocated", startLine: globalMatch + 1, endLine: globalMatch + contentLen };
  }

  // 4. Context-based fuzzy match — context matches but content changed
  const contextMatch = findByContext(anchor, currentLines, storedIdx);
  if (contextMatch !== null) {
    return { status: "outdated", startLine: contextMatch + 1, endLine: contextMatch + contentLen };
  }

  // 5. Partial context match (2 of 3 context lines)
  const partialMatch = findByPartialContext(anchor, currentLines, storedIdx);
  if (partialMatch !== null) {
    return { status: "outdated", startLine: partialMatch + 1, endLine: partialMatch + contentLen };
  }

  // 6. Nothing found
  return { status: "lost", startLine: null, endLine: null };
}

/** Check if content lines match at a specific 0-indexed position */
function matchesContentAt(content: string[], lines: string[], startIdx: number): boolean {
  if (startIdx < 0 || startIdx + content.length > lines.length) return false;
  return content.every((line, i) => lines[startIdx + i] === line);
}

/**
 * Search for an exact content match, spiraling outward from centerIdx.
 * Returns the 0-indexed start position, or null if not found.
 */
function findContentMatch(
  content: string[],
  lines: string[],
  centerIdx: number,
  radius: number,
): number | null {
  // Check center position first
  if (matchesContentAt(content, lines, centerIdx)) return centerIdx;
  for (let offset = 1; offset <= radius; offset++) {
    // Check above
    const above = centerIdx - offset;
    if (above >= 0 && matchesContentAt(content, lines, above)) return above;
    // Check below
    const below = centerIdx + offset;
    if (below + content.length <= lines.length && matchesContentAt(content, lines, below)) {
      return below;
    }
  }
  return null;
}

/**
 * Find position by matching context lines (before and after).
 * Returns 0-indexed start, or null.
 */
function findByContext(anchor: ContentAnchor, lines: string[], storedIdx: number): number | null {
  const { contextBefore, contextAfter, content } = anchor;
  const contentLen = content.length;

  // Search near stored position first, then expand (bounded radius)
  for (let offset = 0; offset <= CONTEXT_SEARCH_RADIUS; offset++) {
    for (const dir of [1, -1] as const) {
      const idx = storedIdx + offset * dir;
      if (idx < 0 || idx + contentLen > lines.length) continue;

      const beforeMatch = matchContextLines(
        contextBefore,
        lines,
        idx - contextBefore.length,
        contextBefore.length,
      );
      const afterMatch = matchContextLines(
        contextAfter,
        lines,
        idx + contentLen,
        contextAfter.length,
      );

      if (beforeMatch >= contextBefore.length && afterMatch >= contextAfter.length) {
        return idx;
      }
    }
    if (offset === 0) continue; // avoid checking same position twice
  }
  return null;
}

/**
 * Find position by partial context match (at least 2 of 3 context lines match on either side).
 */
function findByPartialContext(
  anchor: ContentAnchor,
  lines: string[],
  storedIdx: number,
): number | null {
  const { contextBefore, contextAfter, content } = anchor;
  const contentLen = content.length;
  const minMatch = Math.min(2, Math.max(contextBefore.length, contextAfter.length));
  if (minMatch === 0) return null;

  for (let offset = 0; offset <= CONTEXT_SEARCH_RADIUS; offset++) {
    for (const dir of [1, -1] as const) {
      const idx = storedIdx + offset * dir;
      if (idx < 0 || idx + contentLen > lines.length) continue;

      const beforeMatch = matchContextLines(
        contextBefore,
        lines,
        idx - contextBefore.length,
        contextBefore.length,
      );
      const afterMatch = matchContextLines(
        contextAfter,
        lines,
        idx + contentLen,
        contextAfter.length,
      );

      if (beforeMatch >= minMatch || afterMatch >= minMatch) {
        return idx;
      }
    }
    if (offset === 0) continue;
  }
  return null;
}

/** Count how many context lines match at the given position. */
function matchContextLines(
  context: string[],
  lines: string[],
  startIdx: number,
  count: number,
): number {
  let matched = 0;
  for (let i = 0; i < count; i++) {
    const idx = startIdx + i;
    if (idx >= 0 && idx < lines.length && context[i] === lines[idx]) {
      matched++;
    }
  }
  return matched;
}
