import type { DiffHunk } from "@/api/diff-model";

import type { ScrollAlignmentSection } from "./change-regions";

/** Height in pixels of the expand bar view zone. Shared between EditorPanel, SideBySideDiffView, and LineNumbersColumn. */
export const VIEW_ZONE_HEIGHT = 16;

export interface CollapsibleRegion {
  index: number;
  /** Hidden line range on old side (1-indexed, inclusive) */
  oldStart: number;
  oldEnd: number;
  /** Hidden line range on new side (1-indexed, inclusive) */
  newStart: number;
  newEnd: number;
  /** Max of old/new range size — used for display */
  lineCount: number;
}

interface HunkBoundary {
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
}

function getHunkBoundary(hunk: DiffHunk): HunkBoundary {
  let oldEnd = hunk.oldStart;
  let newEnd = hunk.newStart;
  for (const line of hunk.lines) {
    if (line.type === "delete") oldEnd++;
    else if (line.type === "add") newEnd++;
    else {
      oldEnd++;
      newEnd++;
    }
  }
  return {
    oldStart: hunk.oldStart,
    oldEnd: oldEnd - 1,
    newStart: hunk.newStart,
    newEnd: newEnd - 1,
  };
}

/**
 * Build collapsible regions from gaps between hunks.
 * Each gap gets context lines trimmed from top and bottom;
 * if the remaining hidden range has ≥ minHiddenLines, it becomes a CollapsibleRegion.
 */
export function buildCollapsibleRegions(
  hunks: DiffHunk[],
  oldLineCount: number,
  newLineCount: number,
  contextLines = 3,
  minHiddenLines = 8,
): CollapsibleRegion[] {
  if (hunks.length === 0) {
    // Entire file is unchanged — collapse it if large enough
    const hiddenOld = oldLineCount - 2 * contextLines;
    const hiddenNew = newLineCount - 2 * contextLines;
    const lineCount = Math.max(hiddenOld, hiddenNew);
    if (lineCount < minHiddenLines) return [];
    return [
      {
        index: 0,
        oldStart: contextLines + 1,
        oldEnd: oldLineCount - contextLines,
        newStart: contextLines + 1,
        newEnd: newLineCount - contextLines,
        lineCount,
      },
    ];
  }

  const regions: CollapsibleRegion[] = [];
  const boundaries = hunks.map(getHunkBoundary);
  let idx = 0;

  // Gap before first hunk
  {
    const first = boundaries[0]!;
    const oldGapStart = 1;
    const oldGapEnd = first.oldStart - 1;
    const newGapStart = 1;
    const newGapEnd = first.newStart - 1;
    const region = trimGap(oldGapStart, oldGapEnd, newGapStart, newGapEnd, 0, contextLines, idx);
    if (region && region.lineCount >= minHiddenLines) {
      regions.push(region);
      idx++;
    }
  }

  // Gaps between hunks
  for (let i = 0; i < boundaries.length - 1; i++) {
    const prev = boundaries[i]!;
    const next = boundaries[i + 1]!;
    const oldGapStart = prev.oldEnd + 1;
    const oldGapEnd = next.oldStart - 1;
    const newGapStart = prev.newEnd + 1;
    const newGapEnd = next.newStart - 1;
    const region = trimGap(
      oldGapStart,
      oldGapEnd,
      newGapStart,
      newGapEnd,
      contextLines,
      contextLines,
      idx,
    );
    if (region && region.lineCount >= minHiddenLines) {
      regions.push(region);
      idx++;
    }
  }

  // Gap after last hunk
  {
    const last = boundaries[boundaries.length - 1]!;
    const oldGapStart = last.oldEnd + 1;
    const oldGapEnd = oldLineCount;
    const newGapStart = last.newEnd + 1;
    const newGapEnd = newLineCount;
    const region = trimGap(oldGapStart, oldGapEnd, newGapStart, newGapEnd, contextLines, 0, idx);
    if (region && region.lineCount >= minHiddenLines) {
      regions.push(region);
    }
  }

  return regions;
}

function trimGap(
  oldStart: number,
  oldEnd: number,
  newStart: number,
  newEnd: number,
  topContext: number,
  bottomContext: number,
  index: number,
): CollapsibleRegion | null {
  const trimmedOldStart = oldStart + topContext;
  const trimmedOldEnd = oldEnd - bottomContext;
  const trimmedNewStart = newStart + topContext;
  const trimmedNewEnd = newEnd - bottomContext;

  if (trimmedOldStart > trimmedOldEnd && trimmedNewStart > trimmedNewEnd) return null;

  const oldSize = Math.max(0, trimmedOldEnd - trimmedOldStart + 1);
  const newSize = Math.max(0, trimmedNewEnd - trimmedNewStart + 1);

  return {
    index,
    oldStart: trimmedOldStart,
    oldEnd: trimmedOldEnd,
    newStart: trimmedNewStart,
    newEnd: trimmedNewEnd,
    lineCount: Math.max(oldSize, newSize),
  };
}

/** Monaco IRange shape (avoid importing monaco in pure computation module) */
export interface LineRange {
  startLineNumber: number;
  endLineNumber: number;
  startColumn: number;
  endColumn: number;
}

/**
 * Compute hidden ranges from collapsible regions, excluding expanded ones.
 */
export function computeHiddenRanges(
  regions: CollapsibleRegion[],
  expandedSet: Set<number>,
): { old: LineRange[]; new: LineRange[] } {
  const oldRanges: LineRange[] = [];
  const newRanges: LineRange[] = [];

  for (const region of regions) {
    if (expandedSet.has(region.index)) continue;
    if (region.oldStart <= region.oldEnd) {
      oldRanges.push({
        startLineNumber: region.oldStart,
        endLineNumber: region.oldEnd,
        startColumn: 1,
        endColumn: 1,
      });
    }
    if (region.newStart <= region.newEnd) {
      newRanges.push({
        startLineNumber: region.newStart,
        endLineNumber: region.newEnd,
        startColumn: 1,
        endColumn: 1,
      });
    }
  }

  return { old: oldRanges, new: newRanges };
}

/**
 * Adjust alignment sections to account for hidden lines.
 *
 * Hidden lines are removed from sections (splitting/shrinking as needed),
 * and a small 1-line aligned section is inserted at each collapse point
 * to represent the view zone height in the scroll model.
 */
export function adjustAlignmentSections(
  sections: ScrollAlignmentSection[],
  hiddenOld: LineRange[],
  hiddenNew: LineRange[],
): ScrollAlignmentSection[] {
  if (hiddenOld.length === 0 && hiddenNew.length === 0) return sections;

  // Build sets of hidden line numbers for quick lookup
  const oldHidden = buildHiddenSet(hiddenOld);
  const newHidden = buildHiddenSet(hiddenNew);

  const result: ScrollAlignmentSection[] = [];

  for (const section of sections) {
    // Filter out hidden lines from this section
    const visibleOldLines = countVisible(section.leftStartLine, section.leftEndLine, oldHidden);
    const visibleNewLines = countVisible(section.rightStartLine, section.rightEndLine, newHidden);

    if (visibleOldLines === 0 && visibleNewLines === 0) continue;

    // Rebuild the section with only visible lines
    // We need to map to "visual" line numbers (what Monaco sees after hiding)
    const adjLeftStart = mapToVisualLine(section.leftStartLine, hiddenOld);
    const adjLeftEnd = adjLeftStart + visibleOldLines - 1;
    const adjRightStart = mapToVisualLine(section.rightStartLine, hiddenNew);
    const adjRightEnd = adjRightStart + visibleNewLines - 1;

    if (visibleOldLines > 0 || visibleNewLines > 0) {
      result.push({
        type: section.type,
        leftStartLine: adjLeftStart,
        leftEndLine: visibleOldLines > 0 ? adjLeftEnd : adjLeftStart - 1,
        rightStartLine: adjRightStart,
        rightEndLine: visibleNewLines > 0 ? adjRightEnd : adjRightStart - 1,
      });
    }
  }

  return result;
}

function buildHiddenSet(ranges: LineRange[]): Set<number> {
  const set = new Set<number>();
  for (const r of ranges) {
    for (let i = r.startLineNumber; i <= r.endLineNumber; i++) {
      set.add(i);
    }
  }
  return set;
}

function countVisible(startLine: number, endLine: number, hiddenSet: Set<number>): number {
  let count = 0;
  for (let i = startLine; i <= endLine; i++) {
    if (!hiddenSet.has(i)) count++;
  }
  return count;
}

/**
 * Map a model line number to its visual position after hiding.
 * Visual line = modelLine - (number of hidden lines before it).
 */
function mapToVisualLine(modelLine: number, hiddenRanges: LineRange[]): number {
  let hiddenBefore = 0;
  for (const r of hiddenRanges) {
    if (r.endLineNumber < modelLine) {
      hiddenBefore += r.endLineNumber - r.startLineNumber + 1;
    } else if (r.startLineNumber < modelLine) {
      hiddenBefore += modelLine - r.startLineNumber;
    }
  }
  return modelLine - hiddenBefore;
}
