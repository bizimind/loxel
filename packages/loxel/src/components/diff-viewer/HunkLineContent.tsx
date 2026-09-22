import { useMemo } from "react";

import type { ColumnRange } from "@/components/diff/inline-changes";
import { computeInlineChanges, rangesByLine } from "@/components/diff/inline-changes";

/** A line of a hunk as rendered by the hunk-based diff views, optionally syntax-highlighted */
export interface HunkLine {
  type: "normal" | "add" | "delete";
  content: string;
  html?: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

export interface HunkData {
  header: string;
  lines: HunkLine[];
}

/** Per-line inline change spans, keyed by the line's index within `hunk.lines` */
export type HunkInlineSegments = Map<number, ColumnRange[]>;

/**
 * Compute inline change spans for a hunk. Consecutive delete lines followed by consecutive
 * add lines form a modification block; each block is refined to character ranges.
 */
export function buildHunkInlineSegments(lines: HunkLine[]): HunkInlineSegments {
  const segments: HunkInlineSegments = new Map();
  let deleted: number[] = [];
  let added: number[] = [];

  const flush = () => {
    if (deleted.length > 0 && added.length > 0) {
      const oldLines = deleted.map((i) => lines[i]!.content);
      const newLines = added.map((i) => lines[i]!.content);
      const changes = computeInlineChanges(oldLines, newLines);
      rangesByLine(changes.old, oldLines).forEach((spans, i) => {
        if (spans.length > 0) segments.set(deleted[i]!, spans);
      });
      rangesByLine(changes.new, newLines).forEach((spans, i) => {
        if (spans.length > 0) segments.set(added[i]!, spans);
      });
    }
    deleted = [];
    added = [];
  };

  lines.forEach((line, i) => {
    if (line.type === "delete") {
      // An add followed by a delete starts a new block
      if (added.length > 0) flush();
      deleted.push(i);
    } else if (line.type === "add") {
      added.push(i);
    } else {
      flush();
    }
  });
  flush();

  return segments;
}

export function useHunkInlineSegments(lines: HunkLine[]): HunkInlineSegments {
  return useMemo(() => buildHunkInlineSegments(lines), [lines]);
}

interface HunkLineContentProps {
  line: HunkLine;
  /** Whether `line.html` should be rendered instead of plain content */
  highlighted: boolean;
  segments?: ColumnRange[];
}

/**
 * Renders a hunk line's text with optional intra-line change highlights.
 *
 * The highlights are drawn by a transparent copy of the line positioned underneath the real
 * (possibly syntax-highlighted) text. Both layers share the same font and whitespace handling,
 * so span positions match exactly, including tabs, without touching the highlighter's HTML.
 */
export function HunkLineContent({ line, highlighted, segments }: HunkLineContentProps) {
  const text =
    highlighted && line.html ? (
      <span dangerouslySetInnerHTML={{ __html: line.html }} />
    ) : (
      line.content
    );

  if (!segments || segments.length === 0) return text;

  const className = line.type === "delete" ? "diff-inline-del" : "diff-inline-add";
  const ghost: React.ReactNode[] = [];
  let cursor = 1;
  for (const [i, span] of segments.entries()) {
    if (span.startColumn > cursor) ghost.push(line.content.slice(cursor - 1, span.startColumn - 1));
    ghost.push(
      <span key={i} className={className}>
        {line.content.slice(span.startColumn - 1, span.endColumn - 1)}
      </span>,
    );
    cursor = span.endColumn;
  }
  ghost.push(line.content.slice(cursor - 1));

  return (
    <span className="relative">
      <span
        aria-hidden
        className="diff-inline-ghost pointer-events-none absolute inset-0 select-none"
      >
        {ghost}
      </span>
      <span className="relative">{text}</span>
    </span>
  );
}
