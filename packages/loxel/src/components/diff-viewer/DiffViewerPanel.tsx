import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";

import * as api from "@/api/client";
import type { DiffInfo, FileDiff } from "@/api/diff-model";
import { fileDiffPath } from "@/api/diff-model";
import type { DiffFileContext } from "@/api/review-model";
import { useDiffFileSelection } from "@/hooks/useDiffFileSelection";
import { useReviewContext } from "@/hooks/useReviewContext";
import { parseUnifiedDiff } from "@/lib/parse-unified-diff";
import { cn } from "@/lib/utils";
import { useDiffQuery } from "@/queries/use-repo-queries";
import { useCommentStore } from "@/store/comments";
import { useUIStore } from "@/store/ui";
import { useRepositoryStore } from "@/store/worktree-repository";
import { useReviewStore } from "@/store/worktree-reviews";
import { useWorktreeUI } from "@/store/worktree-ui";
import { useWorktreeStore } from "@/store/worktrees";

import { type DiffFileNavigation, DiffToolbar } from "./DiffToolbar";
import { FileDiffHeader, fileDiffTitle } from "./FileDiffHeader";
import { GitSideBySideDiffView } from "./GitSideBySideDiffView";
import { HunkBasedDiffView } from "./HunkBasedDiffView";

/** What a diff viewer panel shows. */
export type DiffViewerSource =
  /** The worktree's selected changes, computed by git from the repository store's `diffSource` */
  | { type: "git" }
  /**
   * Unified diff text, such as a markdown diff fence, captured when the panel opened. Rendered
   * from its hunks alone: no git refs, so no full-file side-by-side, context expansion or review
   * comments. `sourcePath` is the file the text came from.
   */
  | { type: "patch"; patch: string; sourcePath: string };

/**
 * Diff viewer panel for the center zone: one file of the diff at a time, with a file navigation
 * toolbar and the Unified/Split toggle.
 */
export function DiffViewerPanel({ source }: { source: DiffViewerSource }) {
  switch (source.type) {
    case "git":
      return <GitDiffViewer />;
    case "patch":
      return <PatchDiffViewer patch={source.patch} />;
    default:
      return source satisfies never;
  }
}

/** The worktree's selected changes, fetched from the server, with review comments placed. */
function GitDiffViewer() {
  const diffSource = useRepositoryStore((s) => s.diffSource);
  const { data: diff, isLoading } = useDiffQuery(diffSource);
  const diffViewMode = useUIStore((s) => s.diffViewMode);
  const { commitHash, worktreePath } = useReviewContext();
  // A file edited here stays open after its edits leave nothing to diff.
  const keepsEditedFile = useWorktreeUI(
    (s) => s.editedDiffFile !== null && s.editedDiffFile === s.selectedDiffFile,
  );

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {isLoading ? (
        <div className="text-muted-foreground flex flex-1 items-center justify-center text-xs">
          Loading diff...
        </div>
      ) : !diff || (diff.files.length === 0 && !keepsEditedFile) ? (
        <div className="text-muted-foreground flex flex-1 items-center justify-center text-xs">
          No changes
        </div>
      ) : (
        <GitDiffContent
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

function GitDiffContent({
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
  const { selectedFile, setSelectedFile, editedFile, orderedFiles } = useDiffFileSelection(
    diff.files,
  );

  // The file edited here, once its edits made it match its base and it left the diff
  const keptFile = useMemo<FileDiff | null>(
    () =>
      editedFile &&
      editedFile === selectedFile &&
      !diff.files.some((f) => fileDiffPath(f) === editedFile)
        ? unchangedFileDiff(editedFile)
        : null,
    [editedFile, selectedFile, diff.files],
  );

  const selectedReviewIds = useReviewStore((s) => s.selectedReviewIds);
  const fetchPlacedThreads = useCommentStore((s) => s.fetchPlacedThreads);
  const clearAll = useCommentStore((s) => s.clearAll);

  const diffFiles = useMemo<DiffFileContext[]>(() => {
    const files = keptFile ? [...diff.files, keptFile] : diff.files;
    return files.map((f) => ({
      oldPath: f.oldPath || f.newPath,
      newPath: f.newPath || f.oldPath,
      oldRef: baseRef ?? null,
      newRef: commitHash ?? null,
      worktreePath,
    }));
  }, [diff.files, keptFile, baseRef, commitHash, worktreePath]);

  const placeThreads = useCallback(() => {
    if (selectedReviewIds.length > 0 && diffFiles.length > 0) {
      void fetchPlacedThreads(selectedReviewIds, diffFiles);
    } else {
      clearAll();
    }
  }, [selectedReviewIds, diffFiles, fetchPlacedThreads, clearAll]);
  useEffect(placeThreads, [placeThreads]);

  // The working-tree file edited in the view changed on disk: place its comments on the new lines.
  const placeThreadsRef = useRef(placeThreads);
  placeThreadsRef.current = placeThreads;
  const onWorkingTreeFileChange = useCallback(() => placeThreadsRef.current(), []);

  // Previous/next and the "File N of M" counter follow the Changes tree's order.
  const currentFile =
    orderedFiles.find((f) => fileDiffPath(f) === selectedFile) ?? keptFile ?? orderedFiles[0];
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
    <DiffLayout
      fileNavigation={{
        index: currentFileIndex,
        count: orderedFiles.length,
        onPrevious: goToPrevFile,
        onNext: goToNextFile,
      }}
      // The side-by-side view scrolls its own editors; match FileDiffView's choice of it.
      scrollsItself={viewMode === "split" && !!(commitHash || worktreePath)}
    >
      {currentFile && (
        <FileDiffView
          file={currentFile}
          viewMode={viewMode}
          commitHash={commitHash}
          baseRef={baseRef}
          worktreePath={worktreePath}
          onWorkingTreeFileChange={onWorkingTreeFileChange}
        />
      )}
    </DiffLayout>
  );
}

/** The panel's toolbar over the scroll area of the shown file. */
function DiffLayout({
  fileNavigation,
  scrollsItself,
  children,
}: {
  fileNavigation: DiffFileNavigation;
  /** Whether the content scrolls on its own, so the area must not */
  scrollsItself: boolean;
  children: ReactNode;
}) {
  return (
    <div className="bg-editor-surface flex flex-1 scrollbar-thin flex-col overflow-hidden font-(family-name:--loxel-font-code) text-xs">
      <DiffToolbar fileNavigation={fileNavigation} />
      <div
        className={cn("flex-1", scrollsItself ? "overflow-hidden" : "scrollbar-thin overflow-auto")}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * A patch's files in the order the patch lists them, rendered from its hunks. The patch is parsed
 * once; the panel shows the text it was opened with.
 */
function PatchDiffViewer({ patch }: { patch: string }) {
  const diff = useMemo(() => parseUnifiedDiff(patch), [patch]);
  const viewMode = useUIStore((s) => s.diffViewMode);
  const [fileIndex, setFileIndex] = useState(0);
  const files = diff?.files ?? [];
  const file = files[fileIndex];

  if (!file) {
    return (
      <div className="text-muted-foreground flex flex-1 items-center justify-center text-xs">
        No changes
      </div>
    );
  }

  return (
    <DiffLayout
      fileNavigation={{
        index: fileIndex,
        count: files.length,
        onPrevious: () => setFileIndex((i) => Math.max(i - 1, 0)),
        onNext: () => setFileIndex((i) => Math.min(i + 1, files.length - 1)),
      }}
      scrollsItself={false}
    >
      {file.isBinary ? (
        <BinaryFile />
      ) : (
        <HunkBasedDiffView
          // Files of a patch can share a path; highlighting state belongs to one of them.
          key={fileIndex}
          file={file}
          viewMode={viewMode}
          // A headerless snippet has no path.
          title={fileDiffTitle(file) ?? (fileDiffPath(file) || "Patch")}
        />
      )}
    </DiffLayout>
  );
}

function BinaryFile() {
  return (
    <div className="text-muted-foreground flex h-full items-center justify-center">Binary file</div>
  );
}

/** A file of the working tree that matches its base: shown with no changes. */
function unchangedFileDiff(path: string): FileDiff {
  return {
    oldPath: path,
    newPath: path,
    status: "modified",
    hunks: [],
    isBinary: false,
    additions: 0,
    deletions: 0,
  };
}

function FileDiffView({
  file,
  viewMode,
  commitHash,
  baseRef,
  worktreePath,
  onWorkingTreeFileChange,
}: {
  file: FileDiff;
  viewMode: "split" | "unified";
  commitHash?: string;
  baseRef?: string;
  worktreePath?: string;
  onWorkingTreeFileChange: () => void;
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

  if (file.isBinary) return <BinaryFile />;

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
            onWorkingTreeFileChange={onWorkingTreeFileChange}
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
