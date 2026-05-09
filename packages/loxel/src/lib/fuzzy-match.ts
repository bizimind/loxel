export interface FuzzyResult {
  score: number;
  indices: number[];
}

/** Simple fuzzy subsequence match. Returns score + matched char indices, or null for no match. */
export function fuzzyMatch(query: string, text: string): FuzzyResult | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return { score: 1, indices: [] };

  // Substring match — find the contiguous range
  const subIdx = t.indexOf(q);
  if (subIdx !== -1) {
    const indices = Array.from({ length: q.length }, (_, i) => subIdx + i);
    return { score: subIdx === 0 ? 3 : 2, indices };
  }

  // Fuzzy subsequence match
  const indices: number[] = [];
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      indices.push(ti);
      qi++;
    }
  }
  return qi === q.length ? { score: 1, indices } : null;
}

/**
 * Path-aware fuzzy match optimized for file search.
 * Scores filename matches higher than directory matches and rewards segment-boundary hits.
 *
 * Score tiers (higher is better):
 *  10 — exact filename match (query equals the filename)
 *   8 — filename starts with query
 *   6 — filename contains query as substring
 *   5 — full path starts with query
 *   4 — full path contains query as substring, with segment-boundary bonus
 *   3 — full path contains query as substring
 *   2 — fuzzy subsequence match concentrated in filename
 *   1 — fuzzy subsequence match spread across path
 *
 * Within the same score tier, a `tiebreaker` field (lower = better) orders by path length
 * and how close the match is to the filename.
 */
export function fuzzyMatchPath(
  query: string,
  filePath: string,
): (FuzzyResult & { tiebreaker: number }) | null {
  const q = query.toLowerCase();
  const t = filePath.toLowerCase();
  if (!q) return { score: 0, indices: [], tiebreaker: filePath.length };

  const lastSlash = t.lastIndexOf("/");
  const filename = lastSlash === -1 ? t : t.slice(lastSlash + 1);
  const filenameOffset = lastSlash === -1 ? 0 : lastSlash + 1;

  // --- Exact filename match ---
  if (filename === q) {
    const indices = Array.from({ length: q.length }, (_, i) => filenameOffset + i);
    return { score: 10, indices, tiebreaker: filePath.length };
  }

  // --- Filename starts with query ---
  if (filename.startsWith(q)) {
    const indices = Array.from({ length: q.length }, (_, i) => filenameOffset + i);
    return { score: 8, indices, tiebreaker: filePath.length };
  }

  // --- Filename contains query ---
  const fnIdx = filename.indexOf(q);
  if (fnIdx !== -1) {
    const start = filenameOffset + fnIdx;
    const indices = Array.from({ length: q.length }, (_, i) => start + i);
    return { score: 6, indices, tiebreaker: filePath.length };
  }

  // --- Full path substring match ---
  const pathIdx = t.indexOf(q);
  if (pathIdx !== -1) {
    const indices = Array.from({ length: q.length }, (_, i) => pathIdx + i);
    // Bonus if match starts at a segment boundary (after / or at start)
    const atBoundary = pathIdx === 0 || t[pathIdx - 1] === "/";
    const score = pathIdx === 0 ? 5 : atBoundary ? 4 : 3;
    return { score, indices, tiebreaker: filePath.length };
  }

  // --- Fuzzy subsequence match ---
  const indices: number[] = [];
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      indices.push(ti);
      qi++;
    }
  }
  if (qi < q.length) return null;

  // Score based on how many matched chars fall in the filename portion
  const filenameHits = indices.filter((i) => i >= filenameOffset).length;
  const score = filenameHits > q.length / 2 ? 2 : 1;
  // Tiebreaker: prefer compact matches (less spread) and shorter paths
  const spread = indices[indices.length - 1]! - indices[0]!;
  return { score, indices, tiebreaker: spread + filePath.length * 0.01 };
}
