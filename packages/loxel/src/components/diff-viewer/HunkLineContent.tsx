import { useMemo } from "react";

import type { DiffLine } from "@/api/diff-model";
import type { ColumnRange, InlineChangeBudget } from "@/components/diff/inline-changes";
import {
  computeInlineChanges,
  createInlineChangeBudget,
  rangesByLine,
} from "@/components/diff/inline-changes";
import { RevealedRuns, revealUnseenInHtml } from "@/components/ui/revealed-text";
import { revealUnseen, sliceRuns } from "@/lib/unseen-chars";

/** A line of a hunk as rendered by the hunk-based diff views, optionally syntax-highlighted */
export type HunkLine = DiffLine & { html?: string };

export interface HunkData {
  header: string;
  lines: HunkLine[];
}

/** Per-line inline change spans, keyed by the line's index within `hunk.lines` */
export type HunkInlineSegments = Map<number, ColumnRange[]>;

/**
 * Compute inline change spans for a hunk. Consecutive delete lines followed by consecutive
 * add lines form a modification block; each block is refined to character ranges. Blocks
 * draw from the given budget, which callers share across all hunks of a file.
 */
export function buildHunkInlineSegments(
  lines: HunkLine[],
  budget: InlineChangeBudget = createInlineChangeBudget(),
): HunkInlineSegments {
  const segments: HunkInlineSegments = new Map();
  let deleted: number[] = [];
  let added: number[] = [];

  const flush = () => {
    if (deleted.length > 0 && added.length > 0) {
      const oldLines = deleted.map((i) => lines[i]!.content);
      const newLines = added.map((i) => lines[i]!.content);
      const changes = computeInlineChanges(oldLines, newLines, budget);
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

/** Inline change spans for every hunk of a file, computed under one shared time budget */
export function buildFileInlineSegments(hunks: HunkData[]): HunkInlineSegments[] {
  const budget = createInlineChangeBudget();
  return hunks.map((hunk) => buildHunkInlineSegments(hunk.lines, budget));
}

/**
 * Memoized per-file inline segments. Key on the raw diff hunks rather than the highlighted
 * copies: the line contents are identical, so the pass runs once per file instead of again
 * when syntax highlighting resolves.
 */
export function useFileInlineSegments(hunks: HunkData[]): HunkInlineSegments[] {
  return useMemo(() => buildFileInlineSegments(hunks), [hunks]);
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
 * so span positions match exactly, and no highlight markup enters the highlighter's HTML; it is
 * rewritten only to put in the source line's escapes for unseen characters, which the copy spells
 * from the same runs.
 *
 * Tab alignment constraint: the absolutely positioned ghost is its own block container, so its
 * tab stops are measured from its own left edge, while the real text's tab stops are measured
 * from the enclosing cell. The component must therefore be the first (and only inline) content
 * of its cell; markers or gutters belong in a separate cell.
 */
export function HunkLineContent({ line, highlighted, segments }: HunkLineContentProps) {
  // Characters that would not show (bidirectional controls, zero-width characters) are spelled as
  // escapes in both layers, so the line reads as its bytes and the layers stay aligned. Both take
  // them from the source line's runs: the highlighted markup gets them by source offset, and the
  // ghost slices them, so neither a token nor a span boundary can change what is revealed.
  const runs = revealUnseen(line.content, { as: "code" });
  const html = highlighted ? line.html : undefined;
  const text = html ? (
    <span dangerouslySetInnerHTML={{ __html: revealUnseenInHtml(html, runs) }} />
  ) : (
    <RevealedRuns runs={runs} />
  );

  if (!segments || segments.length === 0) return text;

  const className = line.type === "delete" ? "diff-inline-del" : "diff-inline-add";
  const ghost: React.ReactNode[] = [];
  let cursor = 1;
  for (const [i, span] of segments.entries()) {
    if (span.startColumn > cursor) {
      ghost.push(
        <RevealedRuns
          key={`${i}-before`}
          runs={sliceRuns(runs, cursor - 1, span.startColumn - 1)}
        />,
      );
    }
    ghost.push(
      <span key={i} className={className}>
        <RevealedRuns runs={sliceRuns(runs, span.startColumn - 1, span.endColumn - 1)} />
      </span>,
    );
    cursor = span.endColumn;
  }
  ghost.push(<RevealedRuns key="rest" runs={sliceRuns(runs, cursor - 1, line.content.length)} />);

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
