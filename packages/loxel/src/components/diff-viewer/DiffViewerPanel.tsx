import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  ChevronsUpDownIcon,
  MinusIcon,
  PlusIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import * as api from "@/api/client";
import type { DiffHunk, DiffInfo, FileDiff } from "@/api/diff-model";
import { fileDiffPath } from "@/api/diff-model";
import type { DiffFileContext } from "@/api/review-model";
import { SideBySideDiffView } from "@/components/diff/SideBySideDiffView";
import { Button } from "@/components/ui/button";
import { useReviewContext } from "@/hooks/useReviewContext";
import { type HighlightedHunk, useSyntaxHighlight } from "@/hooks/useSyntaxHighlight";
import { FileTypeIcon } from "@/lib/file-icons";
import { frontendLog } from "@/lib/frontend-logger";
import { cn } from "@/lib/utils";
import { useDiffQuery } from "@/queries/use-repo-queries";
import { useCommentStore } from "@/store/comments";
import { useUIStore } from "@/store/ui";
import { useRepositoryStore } from "@/store/worktree-repository";
import { useReviewStore } from "@/store/worktree-reviews";
import { useWorktreeUI } from "@/store/worktree-ui";
import { useWorktreeStore } from "@/store/worktrees";

/**
 * Standalone diff viewer panel for the center zone.
 * Reads diffSource from the repository store and renders the diff content
 * with file navigation toolbar and view mode toggle.
 */
export function DiffViewerPanel() {
  const diffSource = useRepositoryStore((s) => s.diffSource);
  const { data: diff, isLoading } = useDiffQuery(diffSource);
  const diffViewMode = useUIStore((s) => s.diffViewMode);
  const { commitHash, parentHash, worktreePath } = useReviewContext();

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {isLoading ? (
        <div className="text-muted-foreground flex flex-1 items-center justify-center text-xs">
          Loading diff...
        </div>
      ) : !diff || diff.files.length === 0 ? (
        <div className="text-muted-foreground flex flex-1 items-center justify-center text-xs">
          No changes
        </div>
      ) : (
        <DiffContent
          diff={diff}
          viewMode={diffViewMode}
          commitHash={commitHash}
          parentHash={parentHash}
          worktreePath={worktreePath}
        />
      )}
    </div>
  );
}

function DiffContent({
  diff,
  viewMode,
  commitHash,
  parentHash,
  worktreePath,
}: {
  diff: DiffInfo;
  viewMode: "split" | "unified";
  commitHash?: string;
  parentHash?: string;
  worktreePath?: string;
}) {
  const selectedFile = useWorktreeUI((s) => s.selectedDiffFile);
  const setSelectedFile = useWorktreeUI((s) => s.setSelectedDiffFile);
  const setDiffViewMode = useUIStore((s) => s.setDiffViewMode);

  const selectedReviewIds = useReviewStore((s) => s.selectedReviewIds);
  const fetchPlacedThreads = useCommentStore((s) => s.fetchPlacedThreads);
  const clearAll = useCommentStore((s) => s.clearAll);

  const diffFiles = useMemo<DiffFileContext[]>(() => {
    return diff.files.map((f) => ({
      oldPath: f.oldPath || f.newPath,
      newPath: f.newPath || f.oldPath,
      oldRef: parentHash ?? null,
      newRef: commitHash ?? null,
      worktreePath,
    }));
  }, [diff.files, parentHash, commitHash, worktreePath]);

  useEffect(() => {
    if (selectedReviewIds.length > 0 && diffFiles.length > 0) {
      fetchPlacedThreads(selectedReviewIds, diffFiles);
    } else {
      clearAll();
    }
  }, [selectedReviewIds, diffFiles, fetchPlacedThreads, clearAll]);

  useEffect(() => {
    if (!selectedFile || !diff.files.some((f) => fileDiffPath(f) === selectedFile)) {
      const first = diff.files[0];
      setSelectedFile(first ? fileDiffPath(first) : null);
    }
  }, [diff.files, selectedFile, setSelectedFile]);

  const currentFile = diff.files.find((f) => fileDiffPath(f) === selectedFile) ?? diff.files[0];
  const currentFileIndex = diff.files.findIndex((f) => fileDiffPath(f) === selectedFile);

  const goToPrevFile = () => {
    const prevFile = diff.files[currentFileIndex - 1];
    if (currentFileIndex > 0 && prevFile) {
      setSelectedFile(fileDiffPath(prevFile));
    }
  };

  const goToNextFile = () => {
    const nextFile = diff.files[currentFileIndex + 1];
    if (currentFileIndex < diff.files.length - 1 && nextFile) {
      setSelectedFile(fileDiffPath(nextFile));
    }
  };

  return (
    <div className="bg-editor-surface flex flex-1 scrollbar-thin flex-col overflow-hidden font-mono text-xs">
      {/* Navigation toolbar */}
      <div className="border-border bg-muted/30 flex items-center gap-1 border-b px-2 py-1">
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={goToPrevFile}
          disabled={currentFileIndex <= 0}
          title="Previous file"
        >
          <ArrowLeftIcon className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={goToNextFile}
          disabled={currentFileIndex >= diff.files.length - 1}
          title="Next file"
        >
          <ArrowRightIcon className="size-3.5" />
        </Button>
        <div className="bg-border mx-1 h-4 w-px" />
        <Button
          variant="ghost"
          size="icon-xs"
          title="Previous change (coming soon)"
          disabled
          className="text-muted-foreground/50"
        >
          <ArrowUpIcon className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          title="Next change (coming soon)"
          disabled
          className="text-muted-foreground/50"
        >
          <ArrowDownIcon className="size-3.5" />
        </Button>
        <span className="text-muted-foreground ml-2 text-[10px]">
          File {currentFileIndex + 1} of {diff.files.length}
        </span>

        <div className="flex-1" />

        {/* View mode segmented toggle */}
        <div className="bg-muted flex h-6 items-center rounded-md p-0.5 text-[10px]">
          <button
            className={cn(
              "rounded px-2 py-0.5 transition-colors",
              viewMode === "unified"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => setDiffViewMode("unified")}
          >
            Unified
          </button>
          <button
            className={cn(
              "rounded px-2 py-0.5 transition-colors",
              viewMode === "split"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => setDiffViewMode("split")}
          >
            Split
          </button>
        </div>
      </div>
      <div
        className={cn(
          "flex-1",
          viewMode === "split" && commitHash ? "overflow-hidden" : "scrollbar-thin overflow-auto",
        )}
      >
        {currentFile && (
          <FileDiffView
            file={currentFile}
            viewMode={viewMode}
            commitHash={commitHash}
            parentHash={parentHash}
            worktreePath={worktreePath}
          />
        )}
      </div>
    </div>
  );
}

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

function FileDiffView({
  file,
  viewMode,
  commitHash,
  parentHash,
  worktreePath,
}: {
  file: FileDiff;
  viewMode: "split" | "unified";
  commitHash?: string;
  parentHash?: string;
  worktreePath?: string;
}) {
  const useTrueSideBySide = viewMode === "split" && (commitHash || worktreePath);

  if (file.isBinary) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center">
        Binary file
      </div>
    );
  }

  if (useTrueSideBySide) {
    return (
      <div className="flex h-full flex-col">
        <div className="bg-muted/50 border-border sticky top-0 z-10 flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-xs">
          <FileTypeIcon filename={fileDiffPath(file).split("/").pop() ?? ""} className="size-3.5" />
          <span className="text-foreground font-medium">{fileDiffPath(file)}</span>
          <span className="text-muted-foreground ml-auto flex gap-2 text-[10px]">
            {file.additions > 0 && <span className="text-diff-add-text">+{file.additions}</span>}
            {file.deletions > 0 && <span className="text-diff-del-text">-{file.deletions}</span>}
          </span>
        </div>
        <div className="flex-1 overflow-hidden">
          <SideBySideDiffView
            file={file}
            oldRef={parentHash}
            newRef={commitHash}
            worktreePath={worktreePath}
          />
        </div>
      </div>
    );
  }

  return (
    <HunkBasedDiffView
      file={file}
      viewMode={viewMode}
      commitHash={commitHash}
      parentHash={parentHash}
    />
  );
}

function HunkBasedDiffView({
  file,
  viewMode,
  commitHash,
  parentHash,
}: {
  file: FileDiff;
  viewMode: "split" | "unified";
  commitHash?: string;
  parentHash?: string;
}) {
  const highlighted = useSyntaxHighlight(file);
  const [expandedGaps, setExpandedGaps] = useState<Set<number>>(new Set());
  const [expandedLines, setExpandedLines] = useState<Map<number, string[]>>(new Map());
  const [loadingGaps, setLoadingGaps] = useState<Set<number>>(new Set());

  useEffect(() => {
    setExpandedGaps(new Set());
    setExpandedLines(new Map());
    setLoadingGaps(new Set());
  }, [file.newPath, file.oldPath]);

  const gaps = useMemo(() => calculateHunkGaps(file.hunks), [file.hunks]);
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
        const filePath = file.newPath || file.oldPath;
        const wt = useWorktreeStore.getState().activeWorktreePath;
        if (!wt) return;
        const result = await api.getFileLines(wt, {
          path: filePath,
          startLine: gap.newStartLine,
          endLine: gap.newEndLine,
          ref: commitHash,
        });

        setExpandedLines((prev) => new Map(prev).set(gapKey, result.lines));
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
    [expandedGaps, loadingGaps, file.newPath, file.oldPath, commitHash],
  );

  const hunksToRender = highlighted?.hunks ?? file.hunks;

  return (
    <div className="min-w-max">
      <div className="bg-muted/50 border-border sticky top-0 z-10 flex items-center gap-2 border-b px-3 py-1.5 text-xs">
        <FileTypeIcon filename={fileDiffPath(file).split("/").pop() ?? ""} className="size-3.5" />
        <span className="text-foreground font-medium">{fileDiffPath(file)}</span>
        <span className="text-muted-foreground ml-auto flex gap-2 text-[10px]">
          {file.additions > 0 && <span className="text-diff-add-text">+{file.additions}</span>}
          {file.deletions > 0 && <span className="text-diff-del-text">-{file.deletions}</span>}
        </span>
      </div>

      {viewMode === "split" && (parentHash || commitHash) && (
        <div className="border-border bg-muted/20 flex border-b text-[10px]">
          <div className="border-border flex-1 border-r px-2 py-1">
            <span className="text-muted-foreground">@ </span>
            <span className="text-foreground font-mono">{parentHash?.slice(0, 7) ?? "..."}</span>
            <span className="text-muted-foreground ml-1">(parent)</span>
          </div>
          <div className="flex-1 px-2 py-1">
            <span className="text-muted-foreground">@ </span>
            <span className="text-foreground font-mono">{commitHash?.slice(0, 7) ?? "..."}</span>
            <span className="text-muted-foreground ml-1">(current)</span>
          </div>
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
              <UnifiedHunkView hunk={hunk} highlighted={!!highlighted} />
            ) : (
              <SplitHunkView hunk={hunk} highlighted={!!highlighted} />
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
          <span>Hide {gap.lineCount} lines</span>
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
      <span>{loading ? "Loading..." : `${gap.lineCount} lines hidden`}</span>
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
            <td className="text-muted-foreground/70 px-2 whitespace-pre">
              <span className="mr-2 select-none"> </span>
              {line}
            </td>
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

type HunkLine = {
  type: "normal" | "add" | "delete";
  content: string;
  html?: string;
  oldLineNumber?: number;
  newLineNumber?: number;
};

type HunkData = { header: string; lines: HunkLine[] };

function UnifiedHunkView({
  hunk,
  highlighted,
}: {
  hunk: HunkData | HighlightedHunk;
  highlighted: boolean;
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
            <td className="px-2 whitespace-pre">
              <span className="text-muted-foreground mr-2 select-none">
                {line.type === "add" ? (
                  <PlusIcon className="inline size-3" />
                ) : line.type === "delete" ? (
                  <MinusIcon className="inline size-3" />
                ) : (
                  " "
                )}
              </span>
              {highlighted && "html" in line && line.html ? (
                <span dangerouslySetInnerHTML={{ __html: line.html }} />
              ) : (
                line.content
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SplitHunkView({
  hunk,
  highlighted,
}: {
  hunk: HunkData | HighlightedHunk;
  highlighted: boolean;
}) {
  const leftLines: Array<{ line: HunkLine | null; lineNumber: number | null }> = [];
  const rightLines: Array<{ line: HunkLine | null; lineNumber: number | null }> = [];

  let leftBuffer: HunkLine[] = [];
  let rightBuffer: HunkLine[] = [];

  for (const line of hunk.lines) {
    if (line.type === "delete") {
      leftBuffer.push(line);
    } else if (line.type === "add") {
      rightBuffer.push(line);
    } else {
      const maxLen = Math.max(leftBuffer.length, rightBuffer.length);
      for (let i = 0; i < maxLen; i++) {
        const leftLine = leftBuffer[i];
        const rightLine = rightBuffer[i];
        leftLines.push({ line: leftLine ?? null, lineNumber: leftLine?.oldLineNumber ?? null });
        rightLines.push({ line: rightLine ?? null, lineNumber: rightLine?.newLineNumber ?? null });
      }
      leftBuffer = [];
      rightBuffer = [];

      leftLines.push({ line, lineNumber: line.oldLineNumber ?? null });
      rightLines.push({ line, lineNumber: line.newLineNumber ?? null });
    }
  }

  const maxLen = Math.max(leftBuffer.length, rightBuffer.length);
  for (let i = 0; i < maxLen; i++) {
    const leftLine = leftBuffer[i];
    const rightLine = rightBuffer[i];
    leftLines.push({ line: leftLine ?? null, lineNumber: leftLine?.oldLineNumber ?? null });
    rightLines.push({ line: rightLine ?? null, lineNumber: rightLine?.newLineNumber ?? null });
  }

  const renderContent = (line: HunkLine | null) => {
    if (!line) return "";
    if (highlighted && "html" in line && line.html) {
      return <span dangerouslySetInnerHTML={{ __html: line.html }} />;
    }
    return line.content;
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
                <td className="px-2 whitespace-pre">{renderContent(item.line)}</td>
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
                <td className="px-2 whitespace-pre">{renderContent(item.line)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
