import { useCallback, useEffect, useMemo } from "react";

import * as api from "@/api/client";
import type { DiffInfo, FileDiff } from "@/api/diff-model";
import { fileDiffPath } from "@/api/diff-model";
import type { DiffFileContext } from "@/api/review-model";
import { useDiffFileSelection } from "@/hooks/useDiffFileSelection";
import { useReviewContext } from "@/hooks/useReviewContext";
import { cn } from "@/lib/utils";
import { useDiffQuery } from "@/queries/use-repo-queries";
import { useCommentStore } from "@/store/comments";
import { useUIStore } from "@/store/ui";
import { useRepositoryStore } from "@/store/worktree-repository";
import { useReviewStore } from "@/store/worktree-reviews";
import { useWorktreeStore } from "@/store/worktrees";

import { DiffToolbar } from "./DiffToolbar";
import { FileDiffHeader } from "./FileDiffHeader";
import { GitSideBySideDiffView } from "./GitSideBySideDiffView";
import { HunkBasedDiffView } from "./HunkBasedDiffView";

/**
 * Standalone diff viewer panel for the center zone.
 * Reads diffSource from the repository store and renders the diff content
 * with file navigation toolbar and view mode toggle.
 */
export function DiffViewerPanel() {
  const diffSource = useRepositoryStore((s) => s.diffSource);
  const { data: diff, isLoading } = useDiffQuery(diffSource);
  const diffViewMode = useUIStore((s) => s.diffViewMode);
  const { commitHash, worktreePath } = useReviewContext();

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
          // The base comes from the diff the server actually produced, already
          // resolved to a SHA. Deriving it a second time here is what made the
          // old side resolve `HEAD` in the wrong repository.
          baseRef={diff.baseRef ?? undefined}
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
  baseRef,
  worktreePath,
}: {
  diff: DiffInfo;
  viewMode: "split" | "unified";
  commitHash?: string;
  baseRef?: string;
  worktreePath?: string;
}) {
  const { selectedFile, setSelectedFile, orderedFiles } = useDiffFileSelection(diff.files);

  const selectedReviewIds = useReviewStore((s) => s.selectedReviewIds);
  const fetchPlacedThreads = useCommentStore((s) => s.fetchPlacedThreads);
  const clearAll = useCommentStore((s) => s.clearAll);

  const diffFiles = useMemo<DiffFileContext[]>(() => {
    return diff.files.map((f) => ({
      oldPath: f.oldPath || f.newPath,
      newPath: f.newPath || f.oldPath,
      oldRef: baseRef ?? null,
      newRef: commitHash ?? null,
      worktreePath,
    }));
  }, [diff.files, baseRef, commitHash, worktreePath]);

  useEffect(() => {
    if (selectedReviewIds.length > 0 && diffFiles.length > 0) {
      fetchPlacedThreads(selectedReviewIds, diffFiles);
    } else {
      clearAll();
    }
  }, [selectedReviewIds, diffFiles, fetchPlacedThreads, clearAll]);

  // Previous/next and the "File N of M" counter follow the Changes tree's order.
  const currentFile = orderedFiles.find((f) => fileDiffPath(f) === selectedFile) ?? orderedFiles[0];
  const currentFileIndex = orderedFiles.findIndex((f) => fileDiffPath(f) === selectedFile);

  const goToPrevFile = () => {
    const prevFile = orderedFiles[currentFileIndex - 1];
    if (currentFileIndex > 0 && prevFile) {
      setSelectedFile(fileDiffPath(prevFile));
    }
  };

  const goToNextFile = () => {
    const nextFile = orderedFiles[currentFileIndex + 1];
    if (currentFileIndex < orderedFiles.length - 1 && nextFile) {
      setSelectedFile(fileDiffPath(nextFile));
    }
  };

  return (
    <div className="bg-editor-surface flex flex-1 scrollbar-thin flex-col overflow-hidden font-mono text-xs">
      <DiffToolbar
        fileNavigation={{
          index: currentFileIndex,
          count: orderedFiles.length,
          onPrevious: goToPrevFile,
          onNext: goToNextFile,
        }}
      />
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
            baseRef={baseRef}
            worktreePath={worktreePath}
          />
        )}
      </div>
    </div>
  );
}

function FileDiffView({
  file,
  viewMode,
  commitHash,
  baseRef,
  worktreePath,
}: {
  file: FileDiff;
  viewMode: "split" | "unified";
  commitHash?: string;
  baseRef?: string;
  worktreePath?: string;
}) {
  const useTrueSideBySide = viewMode === "split" && (commitHash || worktreePath);
  const filePath = fileDiffPath(file);

  // Context lines of the new side, read from git at the diff's commit (the working tree if none).
  const loadContextLines = useCallback(
    async (startLine: number, endLine: number) => {
      const wt = useWorktreeStore.getState().activeWorktreePath;
      if (!wt) return [];
      const result = await api.getFileLines(wt, {
        path: filePath,
        startLine,
        endLine,
        ref: commitHash,
      });
      return result.lines;
    },
    [filePath, commitHash],
  );

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
        <FileDiffHeader file={file} />
        <div className="flex-1 overflow-hidden">
          <GitSideBySideDiffView
            file={file}
            oldRef={baseRef}
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
      loadContextLines={loadContextLines}
      splitLabels={
        baseRef || commitHash
          ? {
              old: <RefLabel gitRef={baseRef} role="base" />,
              new: <RefLabel gitRef={commitHash} role="current" />,
            }
          : undefined
      }
    />
  );
}

function RefLabel({ gitRef, role }: { gitRef: string | undefined; role: string }) {
  return (
    <>
      <span className="text-muted-foreground">@ </span>
      <span className="text-foreground font-mono">{gitRef?.slice(0, 7) ?? "..."}</span>
      <span className="text-muted-foreground ml-1">({role})</span>
    </>
  );
}
