import { ChevronsUpDownIcon, MinusIcon, PlusIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { DiffHunk, FileDiff } from "@/api/diff-model";
import { type HighlightedHunk, useSyntaxHighlight } from "@/hooks/useSyntaxHighlight";
import { frontendLog } from "@/lib/frontend-logger";
import { cn } from "@/lib/utils";

import { FileDiffHeader } from "./FileDiffHeader";
import {
  type HunkData,
  type HunkLine,
  HunkLineContent,
  type HunkInlineSegments,
  useFileInlineSegments,
} from "./HunkLineContent";

// --- HunkGap ---

interface HunkGap {
  afterHunkIndex: number;
  oldStartLine: number;
  oldEndLine: number;
  newStartLine: number;
  newEndLine: number;
  lineCount: number;
}

function calculateHunkGaps(hunks: DiffHunk[]): HunkGap[] {
  const gaps: HunkGap[] = [];

  if (hunks.length > 0) {
    const firstHunk = hunks[0];
    if (firstHunk && firstHunk.oldStart > 1) {
      gaps.push({
        afterHunkIndex: -1,
        oldStartLine: 1,
        oldEndLine: firstHunk.oldStart - 1,
        newStartLine: 1,
        newEndLine: firstHunk.newStart - 1,
        lineCount: firstHunk.oldStart - 1,
      });
    }
  }

  for (let i = 0; i < hunks.length - 1; i++) {
    const current = hunks[i];
    const next = hunks[i + 1];
    if (!current || !next) continue;

    const currentOldEnd = current.oldStart + current.oldLines;
    const currentNewEnd = current.newStart + current.newLines;
    const nextOldStart = next.oldStart;
    const nextNewStart = next.newStart;

    const oldGap = nextOldStart - currentOldEnd;
    const newGap = nextNewStart - currentNewEnd;
    const lineCount = Math.max(oldGap, newGap);

    if (lineCount > 0) {
      gaps.push({
        afterHunkIndex: i,
        oldStartLine: currentOldEnd,
        oldEndLine: nextOldStart - 1,
        newStartLine: currentNewEnd,
        newEndLine: nextNewStart - 1,
        lineCount,
      });
    }
  }

  return gaps;
}

/** Reads lines `startLine`..`endLine` (1-based, inclusive) of the new side of the diff. */
export type LoadContextLines = (startLine: number, endLine: number) => Promise<string[]>;

interface HunkBasedDiffViewProps {
  file: FileDiff;
  viewMode: "split" | "unified";
  /** Loads the unchanged lines of a hidden gap; expanded gaps reset when it changes identity. */
  loadContextLines: LoadContextLines;
  /** Labels above the two columns of the split view */
  splitLabels?: { old: ReactNode; new: ReactNode };
  /** Header title; the file's path by default */
  title?: ReactNode;
}

/**
 * Hunk-by-hunk rendering of a file diff, unified or split into two columns, with expandable
 * gaps between hunks. Read-only; used for unified mode and for diffs without full file content.
 */
export function HunkBasedDiffView({
  file,
  viewMode,
  loadContextLines,
  splitLabels,
  title,
}: HunkBasedDiffViewProps) {
  const highlighted = useSyntaxHighlight(file);
  const [expandedGaps, setExpandedGaps] = useState<Set<number>>(new Set());
  const [expandedLines, setExpandedLines] = useState<Map<number, string[]>>(new Map());
  const [loadingGaps, setLoadingGaps] = useState<Set<number>>(new Set());

  useEffect(() => {
    setExpandedGaps(new Set());
    setExpandedLines(new Map());
    setLoadingGaps(new Set());
  }, [loadContextLines]);

  const gaps = useMemo(() => calculateHunkGaps(file.hunks), [file.hunks]);
  const inlineSegments = useFileInlineSegments(file.hunks);
  const gapsByAfterIndex = useMemo(() => {
    const map = new Map<number, HunkGap>();
    for (const gap of gaps) {
      map.set(gap.afterHunkIndex, gap);
    }
    return map;
  }, [gaps]);

  const handleExpandGap = useCallback(
    async (gap: HunkGap) => {
      const gapKey = gap.afterHunkIndex;

      if (expandedGaps.has(gapKey)) {
        setExpandedGaps((prev) => {
          const next = new Set(prev);
          next.delete(gapKey);
          return next;
        });
        return;
      }

      if (loadingGaps.has(gapKey)) return;

      setLoadingGaps((prev) => new Set(prev).add(gapKey));

      try {
        const lines = await loadContextLines(gap.newStartLine, gap.newEndLine);
        setExpandedLines((prev) => new Map(prev).set(gapKey, lines));
        setExpandedGaps((prev) => new Set(prev).add(gapKey));
      } catch (err) {
        frontendLog
          .child("git")
          .error("Failed to fetch context lines", {
            error: err instanceof Error ? err : undefined,
          });
      } finally {
        setLoadingGaps((prev) => {
          const next = new Set(prev);
          next.delete(gapKey);
          return next;
        });
      }
    },
    [expandedGaps, loadingGaps, loadContextLines],
  );

  const hunksToRender = highlighted?.hunks ?? file.hunks;

  return (
    <div className="min-w-max">
      <FileDiffHeader file={file} title={title} />

      {viewMode === "split" && splitLabels && (
        <div className="border-border bg-muted/20 flex border-b text-[10px]">
          <div className="border-border flex-1 border-r px-2 py-1">{splitLabels.old}</div>
          <div className="flex-1 px-2 py-1">{splitLabels.new}</div>
        </div>
      )}

      {gapsByAfterIndex.has(-1) && (
        <ExpandableGap
          gap={gapsByAfterIndex.get(-1)!}
          expanded={expandedGaps.has(-1)}
          loading={loadingGaps.has(-1)}
          lines={expandedLines.get(-1)}
          viewMode={viewMode}
          onToggle={() => handleExpandGap(gapsByAfterIndex.get(-1)!)}
        />
      )}

      {hunksToRender.map((hunk, i) => (
        <div key={i}>
          <div className="border-border border-b last:border-b-0">
            <div className="bg-muted/30 text-muted-foreground px-2 py-1 text-[11px]">
              {hunk.header}
            </div>
            {viewMode === "unified" ? (
              <UnifiedHunkView
                hunk={hunk}
                highlighted={!!highlighted}
                inlineSegments={inlineSegments[i]}
              />
            ) : (
              <SplitHunkView
                hunk={hunk}
                highlighted={!!highlighted}
                inlineSegments={inlineSegments[i]}
              />
            )}
          </div>

          {gapsByAfterIndex.has(i) && (
            <ExpandableGap
              gap={gapsByAfterIndex.get(i)!}
              expanded={expandedGaps.has(i)}
              loading={loadingGaps.has(i)}
              lines={expandedLines.get(i)}
              viewMode={viewMode}
              onToggle={() => handleExpandGap(gapsByAfterIndex.get(i)!)}
            />
          )}
        </div>
      ))}
    </div>
  );
}

function ExpandableGap({
  gap,
  expanded,
  loading,
  lines,
  viewMode,
  onToggle,
}: {
  gap: HunkGap;
  expanded: boolean;
  loading: boolean;
  lines?: string[];
  viewMode: "split" | "unified";
  onToggle: () => void;
}) {
  if (expanded && lines) {
    return (
      <div className="border-border border-b">
        <button
          onClick={onToggle}
          className="bg-muted/10 hover:bg-muted/20 text-muted-foreground flex w-full items-center justify-center gap-1 py-0.5 text-[10px] transition-colors"
        >
          <ChevronsUpDownIcon className="size-3" />
          <span>
            Hide {gap.lineCount} {gap.lineCount === 1 ? "line" : "lines"}
          </span>
        </button>
        {viewMode === "unified" ? (
          <ExpandedContextUnified lines={lines} startLine={gap.newStartLine} />
        ) : (
          <ExpandedContextSplit lines={lines} startLine={gap.newStartLine} />
        )}
      </div>
    );
  }

  return (
    <button
      onClick={onToggle}
      disabled={loading}
      className="bg-muted/10 hover:bg-muted/20 text-muted-foreground border-border flex w-full items-center justify-center gap-1 border-b py-1 text-[10px] transition-colors disabled:opacity-50"
    >
      <ChevronsUpDownIcon className={cn("size-3", loading && "animate-pulse")} />
      <span>
        {loading
          ? "Loading..."
          : `${gap.lineCount} ${gap.lineCount === 1 ? "line" : "lines"} hidden`}
      </span>
    </button>
  );
}

function ExpandedContextUnified({ lines, startLine }: { lines: string[]; startLine: number }) {
  return (
    <table className="w-full border-collapse">
      <tbody>
        {lines.map((line, i) => (
          <tr key={i} className="bg-muted/5">
            <td className="border-border text-muted-foreground/50 w-10 border-r px-2 text-right select-none">
              {startLine + i}
            </td>
            <td className="border-border text-muted-foreground/50 w-10 border-r px-2 text-right select-none">
              {startLine + i}
            </td>
            <td className="w-5 pl-2" />
            <td className="text-muted-foreground/70 px-2 whitespace-pre">{line}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ExpandedContextSplit({ lines, startLine }: { lines: string[]; startLine: number }) {
  return (
    <div className="flex">
      <div className="w-1/2 overflow-x-auto">
        <table className="w-full border-collapse">
          <tbody>
            {lines.map((line, i) => (
              <tr key={i} className="bg-muted/5">
                <td className="text-muted-foreground/50 w-12 px-2 text-right select-none">
                  {startLine + i}
                </td>
                <td className="text-muted-foreground/70 px-2 whitespace-pre">{line}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="bg-border w-px shrink-0" />
      <div className="w-1/2 overflow-x-auto">
        <table className="w-full border-collapse">
          <tbody>
            {lines.map((line, i) => (
              <tr key={i} className="bg-muted/5">
                <td className="text-muted-foreground/50 w-12 px-2 text-right select-none">
                  {startLine + i}
                </td>
                <td className="text-muted-foreground/70 px-2 whitespace-pre">{line}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function UnifiedHunkView({
  hunk,
  highlighted,
  inlineSegments,
}: {
  hunk: HunkData | HighlightedHunk;
  highlighted: boolean;
  inlineSegments: HunkInlineSegments | undefined;
}) {
  return (
    <table className="w-full border-collapse">
      <tbody>
        {hunk.lines.map((line, i) => (
          <tr
            key={i}
            className={cn(
              line.type === "add" && "diff-line-add",
              line.type === "delete" && "diff-line-del",
            )}
          >
            <td
              className={cn(
                "border-border text-muted-foreground w-10 border-r px-2 text-right select-none",
                line.type === "add" && "diff-gutter-add",
                line.type === "delete" && "diff-gutter-del",
              )}
            >
              {line.oldLineNumber ?? ""}
            </td>
            <td
              className={cn(
                "border-border text-muted-foreground w-10 border-r px-2 text-right select-none",
                line.type === "add" && "diff-gutter-add",
                line.type === "delete" && "diff-gutter-del",
              )}
            >
              {line.newLineNumber ?? ""}
            </td>
            {/* Marker lives in its own cell: HunkLineContent must be the first content of its
                block container so its ghost layer shares the real text's tab-stop origin. */}
            <td className="text-muted-foreground w-5 pl-2 select-none">
              {line.type === "add" ? (
                <PlusIcon className="inline size-3" />
              ) : line.type === "delete" ? (
                <MinusIcon className="inline size-3" />
              ) : null}
            </td>
            <td className="px-2 whitespace-pre">
              <HunkLineContent
                line={line}
                highlighted={highlighted}
                segments={inlineSegments?.get(i)}
              />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** A rendered row in the split hunk view; `index` is the line's position in `hunk.lines` */
type SplitRow = { line: HunkLine | null; index: number; lineNumber: number | null };
type BufferedLine = { line: HunkLine; index: number };

function SplitHunkView({
  hunk,
  highlighted,
  inlineSegments,
}: {
  hunk: HunkData | HighlightedHunk;
  highlighted: boolean;
  inlineSegments: HunkInlineSegments | undefined;
}) {
  const leftLines: SplitRow[] = [];
  const rightLines: SplitRow[] = [];

  let leftBuffer: BufferedLine[] = [];
  let rightBuffer: BufferedLine[] = [];

  const flushBuffers = () => {
    const maxLen = Math.max(leftBuffer.length, rightBuffer.length);
    for (let i = 0; i < maxLen; i++) {
      const left = leftBuffer[i];
      const right = rightBuffer[i];
      leftLines.push({
        line: left?.line ?? null,
        index: left?.index ?? -1,
        lineNumber: left?.line.oldLineNumber ?? null,
      });
      rightLines.push({
        line: right?.line ?? null,
        index: right?.index ?? -1,
        lineNumber: right?.line.newLineNumber ?? null,
      });
    }
    leftBuffer = [];
    rightBuffer = [];
  };

  hunk.lines.forEach((line, index) => {
    if (line.type === "delete") {
      leftBuffer.push({ line, index });
    } else if (line.type === "add") {
      rightBuffer.push({ line, index });
    } else {
      flushBuffers();
      leftLines.push({ line, index, lineNumber: line.oldLineNumber ?? null });
      rightLines.push({ line, index, lineNumber: line.newLineNumber ?? null });
    }
  });
  flushBuffers();

  const renderContent = (row: SplitRow) => {
    if (!row.line) return "";
    return (
      <HunkLineContent
        line={row.line}
        highlighted={highlighted}
        segments={inlineSegments?.get(row.index)}
      />
    );
  };

  return (
    <div className="flex">
      <div className="w-1/2 overflow-x-auto">
        <table className="w-full border-collapse">
          <tbody>
            {leftLines.map((item, i) => (
              <tr
                key={i}
                className={cn(
                  item.line?.type === "delete" && "diff-line-del",
                  !item.line && "bg-muted/10",
                )}
              >
                <td
                  className={cn(
                    "text-muted-foreground w-12 px-2 text-right select-none",
                    item.line?.type === "delete" && "diff-gutter-del",
                  )}
                >
                  {item.lineNumber ?? ""}
                </td>
                <td className="px-2 whitespace-pre">{renderContent(item)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="bg-border w-px shrink-0" />

      <div className="w-1/2 overflow-x-auto">
        <table className="w-full border-collapse">
          <tbody>
            {rightLines.map((item, i) => (
              <tr
                key={i}
                className={cn(
                  item.line?.type === "add" && "diff-line-add",
                  !item.line && "bg-muted/10",
                )}
              >
                <td
                  className={cn(
                    "text-muted-foreground w-12 px-2 text-right select-none",
                    item.line?.type === "add" && "diff-gutter-add",
                  )}
                >
                  {item.lineNumber ?? ""}
                </td>
                <td className="px-2 whitespace-pre">{renderContent(item)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
