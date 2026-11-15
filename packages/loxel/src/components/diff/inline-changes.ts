import { DefaultLinesDiffComputer } from "monaco-editor/editor/common/diff/defaultLinesDiffComputer/defaultLinesDiffComputer";
import type { InnerRangeMapping } from "monaco-editor/editor/common/diff/defaultLinesDiffComputer/defaultLinesDiffComputer";

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

/** Whether an edit spanning 0-based [start, end) of `line` could shift by one character */
function isAmbiguousEdit(line: string, start: number, end: number): boolean {
  const slidesRight = end < line.length && line[start] === line[end];
  const slidesLeft = start > 0 && line[start - 1] === line[end - 1];
  return slidesRight || slidesLeft;
}

function isLowSurrogate(text: string, index: number): boolean {
  const code = text.charCodeAt(index);
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Monaco's minimal character diff can match a run of text at different offsets on each side,
 * reporting a pure insertion and a pure deletion around it: `8.3.1` -> `8.8.3` becomes "insert
 * `8.`" and "delete `.1`" around a shifted `8.3`. When one of the two edits is ambiguous (its
 * text repeats next to it, like the inserted `8.` beside the original `8.`), the run between
 * them was anchored by that repetition rather than by shared content, so join the pair into one
 * replacement and leave the common prefix and suffix unmarked. Unambiguous pairs are genuine
 * moves and keep Monaco's ranges: `a/b/c` -> `b/c/d` still drops `a/` and appends `/d`.
 * Only pairs separated by a short whitespace-free run are considered; Monaco itself already
 * merges edits separated by at most two characters.
 */
function joinShiftedEdit(
  previous: InnerRangeMapping,
  change: InnerRangeMapping,
  oldLines: string[],
  newLines: string[],
): InnerRangeMapping | undefined {
  const insertionThenDeletion =
    isEmptyRange(previous.originalRange) && isEmptyRange(change.modifiedRange);
  const deletionThenInsertion =
    isEmptyRange(previous.modifiedRange) && isEmptyRange(change.originalRange);
  if (!insertionThenDeletion && !deletionThenInsertion) return;

  const oldRange = { ...previous.originalRange, endColumn: change.originalRange.endColumn };
  const newRange = { ...previous.modifiedRange, endColumn: change.modifiedRange.endColumn };
  // Mappings are ordered, so matching the outer line numbers also excludes multi-line edits.
  if (
    oldRange.startLineNumber !== change.originalRange.endLineNumber ||
    newRange.startLineNumber !== change.modifiedRange.endLineNumber
  )
    return;

  const oldLine = oldLines[oldRange.startLineNumber - 1]!;
  const between = oldLine.slice(
    previous.originalRange.endColumn - 1,
    change.originalRange.startColumn - 1,
  );
  // The unchanged run sits inside both joined ranges; what remains is the two edits.
  const joinedLength =
    oldRange.endColumn - oldRange.startColumn + (newRange.endColumn - newRange.startColumn);
  const editLength = joinedLength - 2 * between.length;
  if (/\s/.test(between) || between.length > editLength) return;

  const newLine = newLines[newRange.startLineNumber - 1]!;
  const [insertion, deletion] = insertionThenDeletion
    ? [previous.modifiedRange, change.originalRange]
    : [change.modifiedRange, previous.originalRange];
  if (
    !isAmbiguousEdit(newLine, insertion.startColumn - 1, insertion.endColumn - 1) &&
    !isAmbiguousEdit(oldLine, deletion.startColumn - 1, deletion.endColumn - 1)
  )
    return;

  const oldText = oldLine.slice(oldRange.startColumn - 1, oldRange.endColumn - 1);
  const newText = newLine.slice(newRange.startColumn - 1, newRange.endColumn - 1);

  let prefix = 0;
  while (prefix < Math.min(oldText.length, newText.length) && oldText[prefix] === newText[prefix]) {
    prefix++;
  }
  // Never split a surrogate pair: back off to the start of a shared astral character.
  if (prefix > 0 && (isLowSurrogate(oldText, prefix) || isLowSurrogate(newText, prefix))) prefix--;
  let oldLength = oldText.length;
  let newLength = newText.length;
  while (
    oldLength > prefix &&
    newLength > prefix &&
    oldText[oldLength - 1] === newText[newLength - 1]
  ) {
    oldLength--;
    newLength--;
  }
  if (isLowSurrogate(oldText, oldLength) || isLowSurrogate(newText, newLength)) {
    oldLength++;
    newLength++;
  }
  return {
    originalRange: {
      ...oldRange,
      startColumn: oldRange.startColumn + prefix,
      endColumn: oldRange.startColumn + oldLength,
    },
    modifiedRange: {
      ...newRange,
      startColumn: newRange.startColumn + prefix,
      endColumn: newRange.startColumn + newLength,
    },
  };
}

function joinShiftedEdits(
  changes: InnerRangeMapping[],
  oldLines: string[],
  newLines: string[],
): InnerRangeMapping[] {
  const result: InnerRangeMapping[] = [];
  for (const change of changes) {
    const previous = result.at(-1);
    const joined = previous && joinShiftedEdit(previous, change, oldLines, newLines);
    if (joined) result[result.length - 1] = joined;
    else result.push(change);
  }
  return result;
}

/**
 * Compute intra-line changes between the old and new lines of one modification block.
 *
 * Delegates to the diff computer Monaco bundles from VS Code: a character-level diff refined
 * by VS Code's heuristics (short matches between edits are merged, edits covering most of a
 * word extend to the whole word, boundaries slide to token edges), plus `joinShiftedEdits`
 * for matches Monaco aligns at different offsets on each side. Single-character edits such
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

  const monacoChanges = result.changes.flatMap((change) => change.innerChanges ?? []);
  // Gate on Monaco's own ranges: a joined edit absorbs the unchanged run between its two
  // halves, and that presentation choice must not tip a block into having no highlights.
  const monaco = splitSides(monacoChanges);
  const ratio = Math.max(changedRatio(monaco.old, oldLines), changedRatio(monaco.new, newLines));
  if (ratio > MAX_CHANGED_RATIO) return EMPTY;

  return splitSides(
    result.changes.flatMap((change) =>
      joinShiftedEdits(change.innerChanges ?? [], oldLines, newLines),
    ),
  );
}

function splitSides(changes: InnerRangeMapping[]): InlineChanges {
  const old: InlineRange[] = [];
  const updated: InlineRange[] = [];
  for (const inner of changes) {
    if (!isEmptyRange(inner.originalRange)) old.push({ ...inner.originalRange });
    if (!isEmptyRange(inner.modifiedRange)) updated.push({ ...inner.modifiedRange });
  }
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
