import { DefaultLinesDiffComputer } from "monaco-editor/editor/common/diff/defaultLinesDiffComputer/defaultLinesDiffComputer";

import type { DiffHunk, DiffLine } from "@/api/diff-model";

/** A line diff of two texts in the shape the server produces for git diffs */
export interface ComputedFileDiff {
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}

/** Unchanged lines kept around each change, as in `git diff` */
const CONTEXT_LINES = 3;
/** Past this, Monaco returns a coarser (still valid) diff instead of an optimal one */
const MAX_COMPUTATION_MS = 1000;

const computer = new DefaultLinesDiffComputer();

/** Split text into lines the way a Monaco model does, so line numbers match the editor's. */
export function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

interface LineChange {
  /** First changed line on each side, 1-based */
  oldStart: number;
  newStart: number;
  /** One past the last changed line on each side; equal to the start for an empty side */
  oldEnd: number;
  newEnd: number;
}

/**
 * Diff two files line by line on the client, producing git-style hunks with three lines of
 * context, so content that does not come from git (two arbitrary files) can be rendered by the
 * same views as a server diff. Uses the diff computer Monaco bundles from VS Code.
 *
 * Hunk headers follow git's convention: a side with no lines in the hunk starts at the line
 * before the change.
 */
export function computeFileDiff(oldLines: string[], newLines: string[]): ComputedFileDiff {
  const { changes } = computer.computeDiff(oldLines, newLines, {
    ignoreTrimWhitespace: false,
    maxComputationTimeMs: MAX_COMPUTATION_MS,
    computeMoves: false,
  });
  const lineChanges: LineChange[] = changes.map((c) => ({
    oldStart: c.original.startLineNumber,
    oldEnd: c.original.endLineNumberExclusive,
    newStart: c.modified.startLineNumber,
    newEnd: c.modified.endLineNumberExclusive,
  }));

  const hunks: DiffHunk[] = [];
  let additions = 0;
  let deletions = 0;
  for (const group of groupChanges(lineChanges)) {
    const hunk = buildHunk(group, oldLines, newLines);
    for (const line of hunk.lines) {
      if (line.type === "add") additions++;
      else if (line.type === "delete") deletions++;
    }
    hunks.push(hunk);
  }
  return { hunks, additions, deletions };
}

/** Changes whose context would touch or overlap share a hunk, as in git. */
function groupChanges(changes: LineChange[]): LineChange[][] {
  const groups: LineChange[][] = [];
  let current: LineChange[] = [];
  for (const change of changes) {
    const prev = current.at(-1);
    if (prev && change.oldStart - prev.oldEnd > 2 * CONTEXT_LINES) {
      groups.push(current);
      current = [];
    }
    current.push(change);
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function buildHunk(group: LineChange[], oldLines: string[], newLines: string[]): DiffHunk {
  const first = group[0]!;
  const last = group.at(-1)!;
  // Lines outside changes are identical on both sides, so context counts match on both.
  const before = Math.min(CONTEXT_LINES, first.oldStart - 1);
  const after = Math.min(CONTEXT_LINES, oldLines.length + 1 - last.oldEnd);

  const lines: DiffLine[] = [];
  let oldLine = first.oldStart - before;
  let newLine = first.newStart - before;
  const pushContext = (untilOld: number) => {
    while (oldLine < untilOld) {
      lines.push({
        type: "normal",
        content: oldLines[oldLine - 1] ?? "",
        oldLineNumber: oldLine,
        newLineNumber: newLine,
      });
      oldLine++;
      newLine++;
    }
  };

  for (const change of group) {
    pushContext(change.oldStart);
    for (; oldLine < change.oldEnd; oldLine++) {
      lines.push({ type: "delete", content: oldLines[oldLine - 1] ?? "", oldLineNumber: oldLine });
    }
    for (; newLine < change.newEnd; newLine++) {
      lines.push({ type: "add", content: newLines[newLine - 1] ?? "", newLineNumber: newLine });
    }
  }
  pushContext(last.oldEnd + after);

  const oldFirst = first.oldStart - before;
  const newFirst = first.newStart - before;
  const oldCount = oldLine - oldFirst;
  const newCount = newLine - newFirst;
  const oldStart = oldCount > 0 ? oldFirst : oldFirst - 1;
  const newStart = newCount > 0 ? newFirst : newFirst - 1;
  return {
    oldStart,
    oldLines: oldCount,
    newStart,
    newLines: newCount,
    header: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
    lines,
  };
}
