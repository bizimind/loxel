import { diffArrays } from "diff";

export type MergeResult =
  | { ok: true; merged: string }
  | { ok: false; reason: "conflict" | "no-base" };

export interface MergeOptions {
  /**
   * When true, conflicting hunks are resolved by keeping "ours" (dropping "theirs").
   * Used by format-on-save: formatting applies where the user hasn't edited,
   * but user's edits win where they overlap with formatting changes.
   */
  preferOurs?: boolean;
}

interface Hunk {
  /** 0-indexed start in base lines (inclusive). */
  baseStart: number;
  /** 0-indexed end in base lines (exclusive). */
  baseEnd: number;
  /** Replacement lines for this range. */
  lines: string[];
}

/**
 * Line-based 3-way merge.
 * Computes diff(base, ours) and diff(base, theirs), detects overlapping hunks.
 * Returns the merged result if no conflicts, or signals a conflict.
 *
 * With `preferOurs: true`, conflicting hunks keep "ours" instead of failing.
 */
export function threeWayMerge(
  base: string,
  ours: string,
  theirs: string,
  options?: MergeOptions,
): MergeResult {
  if (ours === theirs) return { ok: true, merged: ours };
  if (base === ours) return { ok: true, merged: theirs };
  if (base === theirs) return { ok: true, merged: ours };

  const baseLines = splitLines(base);
  const oursLines = splitLines(ours);
  const theirsLines = splitLines(theirs);

  const oursHunks = computeHunks(baseLines, oursLines);
  const theirsHunks = computeHunks(baseLines, theirsLines);

  // Build set of "theirs" hunks that conflict with "ours".
  // When preferOurs, these are dropped instead of causing a failure.
  const droppedTheirs = new Set<Hunk>();

  for (const oh of oursHunks) {
    for (const th of theirsHunks) {
      const overlaps =
        (oh.baseStart < th.baseEnd && th.baseStart < oh.baseEnd) ||
        (oh.baseStart === oh.baseEnd &&
          th.baseStart === th.baseEnd &&
          oh.baseStart === th.baseStart);
      if (overlaps) {
        if (hunksEqual(oh, th)) continue;
        if (options?.preferOurs) {
          droppedTheirs.add(th);
        } else {
          return { ok: false, reason: "conflict" };
        }
      }
    }
  }

  // Filter out dropped "theirs" hunks
  const effectiveTheirsHunks = theirsHunks.filter((h) => !droppedTheirs.has(h));

  const merged = interleave(baseLines, oursHunks, effectiveTheirsHunks);
  return { ok: true, merged: merged.join("\n") };
}

/** Split content into lines. Preserves trailing-newline semantics. */
function splitLines(content: string): string[] {
  if (content === "") return [];
  return content.split("\n");
}

/** Convert a diffArrays result into hunks indexed by base line positions. */
function computeHunks(base: string[], changed: string[]): Hunk[] {
  const changes = diffArrays(base, changed);
  const hunks: Hunk[] = [];
  let baseIdx = 0;

  for (let i = 0; i < changes.length; i++) {
    const change = changes[i]!;
    if (!change.added && !change.removed) {
      // Common lines — advance base cursor
      baseIdx += change.count!;
      continue;
    }

    // Collect contiguous add/remove pairs into a single hunk
    const baseStart = baseIdx;
    let lines: string[] = [];

    if (change.removed) {
      baseIdx += change.count!;
      // Check if followed by an add (replacement)
      const next = changes[i + 1];
      if (next?.added) {
        lines = next.value;
        i++; // skip the add
      }
    } else if (change.added) {
      lines = change.value;
    }

    hunks.push({ baseStart, baseEnd: baseIdx, lines });
  }

  return hunks;
}

function hunksEqual(a: Hunk, b: Hunk): boolean {
  if (a.baseStart !== b.baseStart || a.baseEnd !== b.baseEnd) return false;
  if (a.lines.length !== b.lines.length) return false;
  return a.lines.every((line, i) => line === b.lines[i]);
}

/**
 * Interleave base lines with non-overlapping hunks from both sides.
 * Hunks are sorted by baseStart and applied in order.
 */
function interleave(baseLines: string[], oursHunks: Hunk[], theirsHunks: Hunk[]): string[] {
  // Merge and sort all hunks by baseStart. For identical ranges, deduplicate.
  const allHunks = deduplicateHunks([...oursHunks, ...theirsHunks]);
  allHunks.sort((a, b) => a.baseStart - b.baseStart || a.baseEnd - b.baseEnd);

  const result: string[] = [];
  let baseIdx = 0;

  for (const hunk of allHunks) {
    // Emit unchanged base lines before this hunk
    while (baseIdx < hunk.baseStart) {
      result.push(baseLines[baseIdx]!);
      baseIdx++;
    }
    // Emit the hunk's replacement lines
    result.push(...hunk.lines);
    // Skip the base lines covered by this hunk
    baseIdx = hunk.baseEnd;
  }

  // Emit remaining base lines
  while (baseIdx < baseLines.length) {
    result.push(baseLines[baseIdx]!);
    baseIdx++;
  }

  return result;
}

/** Remove duplicate hunks (identical range + content from both sides). */
function deduplicateHunks(hunks: Hunk[]): Hunk[] {
  const seen = new Set<string>();
  return hunks.filter((h) => {
    const key = `${h.baseStart}:${h.baseEnd}:${h.lines.join("\n")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
