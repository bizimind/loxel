import { DefaultLinesDiffComputer } from "monaco-editor/editor/common/diff/defaultLinesDiffComputer/defaultLinesDiffComputer";

import type { ChangePair } from "./change-regions";

/**
 * A character range within a block of lines. 1-based lines and columns, end column exclusive
 * (Monaco's IRange convention). May span multiple lines.
 */
export interface InlineRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

/** Intra-line changes for both sides of a modification block */
export interface InlineChanges {
  old: InlineRange[];
  new: InlineRange[];
}

/** A column span on a single line. 1-based, end exclusive. */
export interface ColumnRange {
  startColumn: number;
  endColumn: number;
}

/** Blocks larger than this are not refined; they are rewrites, not edits */
const MAX_BLOCK_LINES = 500;
/** If more than this fraction of a block's characters changed, inline highlights are noise */
const MAX_CHANGED_RATIO = 0.7;
/** Upper bound for all character diffs of one file, shared by every block */
const MAX_FILE_COMPUTATION_MS = 200;

/**
 * A deadline shared by every block of one file. Each block receives only the remaining time,
 * so a file full of pathological blocks degrades to plain modifications instead of stacking
 * per-block timeouts into a frozen frame.
 */
export interface InlineChangeBudget {
  /** Absolute `performance.now()` timestamp after which no more diffs are computed */
  readonly deadline: number;
}

export function createInlineChangeBudget(totalMs = MAX_FILE_COMPUTATION_MS): InlineChangeBudget {
  return { deadline: performance.now() + totalMs };
}

const EMPTY: InlineChanges = { old: [], new: [] };

const computer = new DefaultLinesDiffComputer();

function isEmptyRange(r: InlineRange): boolean {
  return r.startLineNumber === r.endLineNumber && r.startColumn === r.endColumn;
}

function rangeLength(r: InlineRange, lines: string[]): number {
  if (r.startLineNumber === r.endLineNumber) return r.endColumn - r.startColumn;
  let length = (lines[r.startLineNumber - 1]?.length ?? 0) - (r.startColumn - 1);
  for (let line = r.startLineNumber + 1; line < r.endLineNumber; line++) {
    length += lines[line - 1]?.length ?? 0;
  }
  return length + (r.endColumn - 1);
}

function changedRatio(ranges: InlineRange[], lines: string[]): number {
  const total = lines.reduce((sum, line) => sum + line.length, 0);
  if (total === 0) return 0;
  const changed = ranges.reduce((sum, r) => sum + rangeLength(r, lines), 0);
  return changed / total;
}

/**
 * Compute intra-line changes between the old and new lines of one modification block.
 *
 * Delegates to the diff computer Monaco bundles from VS Code: a character-level diff refined
 * by VS Code's heuristics (short matches between edits are merged, edits covering most of a
 * word extend to the whole word, boundaries slide to token edges). Single-character edits such
 * as a fixed typo stay single-character; rewritten identifiers highlight as whole words.
 *
 * Returns empty ranges when the block is too large, the budget is exhausted or the diff timed
 * out, or most of the block changed, so near-total rewrites render as plain modifications
 * instead of solid highlights.
 */
export function computeInlineChanges(
  oldLines: string[],
  newLines: string[],
  budget: InlineChangeBudget = createInlineChangeBudget(),
): InlineChanges {
  if (oldLines.length === 0 || newLines.length === 0) return EMPTY;
  if (oldLines.length > MAX_BLOCK_LINES || newLines.length > MAX_BLOCK_LINES) return EMPTY;

  // Monaco treats maxComputationTimeMs === 0 as "no limit", so an exhausted budget must
  // short-circuit here rather than be passed through.
  const remainingMs = Math.ceil(budget.deadline - performance.now());
  if (remainingMs <= 0) return EMPTY;

  const result = computer.computeDiff(oldLines, newLines, {
    ignoreTrimWhitespace: false,
    maxComputationTimeMs: remainingMs,
    computeMoves: false,
  });
  if (result.hitTimeout) return EMPTY;

  const old: InlineRange[] = [];
  const updated: InlineRange[] = [];
  for (const change of result.changes) {
    for (const inner of change.innerChanges ?? []) {
      if (!isEmptyRange(inner.originalRange)) old.push({ ...inner.originalRange });
      if (!isEmptyRange(inner.modifiedRange)) updated.push({ ...inner.modifiedRange });
    }
  }

  const ratio = Math.max(changedRatio(old, oldLines), changedRatio(updated, newLines));
  if (ratio > MAX_CHANGED_RATIO) return EMPTY;

  return { old, new: updated };
}

function offsetRanges(ranges: InlineRange[], lineOffset: number): InlineRange[] {
  return ranges.map((r) => ({
    ...r,
    startLineNumber: r.startLineNumber + lineOffset,
    endLineNumber: r.endLineNumber + lineOffset,
  }));
}

/**
 * Compute inline changes for every modification pair of a file, with ranges expressed in
 * absolute line numbers of the old and new file contents. All pairs share one time budget.
 */
export function buildInlineChangesForPairs(
  pairs: ChangePair[],
  oldLines: string[],
  newLines: string[],
  budget: InlineChangeBudget = createInlineChangeBudget(),
): InlineChanges {
  const old: InlineRange[] = [];
  const updated: InlineRange[] = [];
  for (const pair of pairs) {
    if (pair.type !== "modify") continue;
    const changes = computeInlineChanges(
      oldLines.slice(pair.oldStart - 1, pair.oldEnd),
      newLines.slice(pair.newStart - 1, pair.newEnd),
      budget,
    );
    old.push(...offsetRanges(changes.old, pair.oldStart - 1));
    updated.push(...offsetRanges(changes.new, pair.newStart - 1));
  }
  return { old, new: updated };
}

/**
 * Split (possibly multi-line) ranges into per-line column spans, for renderers that draw one
 * line at a time. Index i of the result holds the spans for line i + 1.
 */
export function rangesByLine(ranges: InlineRange[], lines: string[]): ColumnRange[][] {
  const result: ColumnRange[][] = lines.map(() => []);
  for (const r of ranges) {
    for (let line = r.startLineNumber; line <= r.endLineNumber; line++) {
      const lineText = lines[line - 1];
      if (lineText === undefined) continue;
      const startColumn = line === r.startLineNumber ? r.startColumn : 1;
      const endColumn = line === r.endLineNumber ? r.endColumn : lineText.length + 1;
      if (endColumn > startColumn) result[line - 1]!.push({ startColumn, endColumn });
    }
  }
  return result;
}
