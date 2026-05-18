import { useQuery } from "@tanstack/react-query";
import type { editor } from "monaco-editor";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import * as api from "@/api/client";
import type { TsgoDiagnostic } from "@/api/diagnostics-model";
import type { FileDiff } from "@/api/diff-model";
import { fileDiffPath } from "@/api/diff-model";
import { AddCommentButton } from "@/components/comments/AddCommentButton";
import { CommentComposer } from "@/components/comments/CommentComposer";
import { useCollapsedRegions } from "@/hooks/useCollapsedRegions";
import { useMonacoSyncScroll } from "@/hooks/useMonacoSyncScroll";
import { detectLanguage } from "@/lib/highlighter";
import { toMonacoLanguage } from "@/lib/monaco-theme";
import { queryKeys } from "@/queries/query-keys";
import { useQueryScope } from "@/queries/use-scope";
import { useCommentStore } from "@/store/comments";
import { useUIStore } from "@/store/ui";
import { useReviewStore } from "@/store/worktree-reviews";

import { buildChangeRegions, buildScrollAlignment } from "./change-regions";
import { DiffGutter } from "./DiffGutter";
import type { ViewZoneDescriptor } from "./EditorPanel";
import { EditorPanel } from "./EditorPanel";
import { LineNumbersColumn } from "./LineNumbersColumn";
import { VIEW_ZONE_HEIGHT, adjustAlignmentSections } from "./unchanged-regions";

const LINE_HEIGHT = 22; // px per line — must match Monaco editor lineHeight

interface SideBySideDiffViewProps {
  file: FileDiff;
  oldRef: string | undefined;
  newRef: string | undefined;
  /** Worktree path for reading working tree files (uncommitted changes) */
  worktreePath?: string;
}

export function SideBySideDiffView({
  file,
  oldRef,
  newRef,
  worktreePath,
}: SideBySideDiffViewProps) {
  const darkMode = useUIStore((s) => s.darkMode);
  const { activeProjectPath, activeWorktreePath } = useQueryScope();

  // Review state
  const activeReviewId = useReviewStore((s) => s.activeReviewId);

  // Comments state — server-placed threads
  const setActiveThread = useCommentStore((s) => s.setActiveThread);
  const pendingAnchor = useCommentStore((s) => s.pendingAnchor);
  const setPendingAnchor = useCommentStore((s) => s.setPendingAnchor);
  const getThreadsForFile = useCommentStore((s) => s.getThreadsForFile);
  const placedThreadsByFile = useCommentStore((s) => s.placedThreadsByFile);

  // Fetch full file content for both versions
  const filePath = fileDiffPath(file);
  const oldPath = file.oldPath || file.newPath;

  const { data: oldFile, isLoading: loadingOld } = useQuery({
    queryKey: queryKeys.fileContent(activeProjectPath, oldPath, oldRef, worktreePath),
    queryFn: () =>
      oldRef
        ? api.getFileContent({ path: oldPath, ref: oldRef, wt: activeWorktreePath ?? undefined })
        : Promise.resolve({ lines: [] }),
    enabled: file.status !== "added",
  });

  const { data: newFile, isLoading: loadingNew } = useQuery({
    queryKey: queryKeys.fileContent(activeProjectPath, filePath, newRef, worktreePath),
    queryFn: () => {
      // When viewing uncommitted changes, read new side from disk
      if (worktreePath && !newRef) {
        return api.getFileContent({ path: filePath, worktree: worktreePath });
      }
      return newRef
        ? api.getFileContent({ path: filePath, ref: newRef, wt: activeWorktreePath ?? undefined })
        : Promise.resolve({ lines: [] });
    },
    enabled: file.status !== "deleted",
  });

  const isLoading = loadingOld || loadingNew;
  const oldLines = oldFile?.lines ?? [];
  const newLines = newFile?.lines ?? [];

  // Fetch tsgo diagnostics for both refs
  const { data: oldDiagData } = useQuery({
    queryKey: queryKeys.diagnostics(activeProjectPath, oldRef, undefined),
    queryFn: () =>
      oldRef && activeWorktreePath
        ? api.getDiagnostics(activeWorktreePath, oldRef)
        : Promise.resolve({ diagnostics: [] }),
    enabled: !!oldRef && !!activeWorktreePath,
  });
  const { data: newDiagData } = useQuery({
    queryKey: queryKeys.diagnostics(activeProjectPath, newRef, worktreePath),
    queryFn: () => {
      if (!activeWorktreePath) return Promise.resolve({ diagnostics: [] });
      if (worktreePath && !newRef)
        return api.getDiagnostics(activeWorktreePath, undefined, worktreePath);
      if (newRef) return api.getDiagnostics(activeWorktreePath, newRef);
      return Promise.resolve({ diagnostics: [] });
    },
    enabled: !!newRef || !!worktreePath,
  });

  // Filter diagnostics to this file
  const oldDiagnostics = useMemo<TsgoDiagnostic[]>(() => {
    if (!oldDiagData?.diagnostics) return [];
    return oldDiagData.diagnostics.filter((d) => d.file === oldPath);
  }, [oldDiagData, oldPath]);

  const newDiagnostics = useMemo<TsgoDiagnostic[]>(() => {
    if (!newDiagData?.diagnostics) return [];
    return newDiagData.diagnostics.filter((d) => d.file === filePath);
  }, [newDiagData, filePath]);

  // Build change regions from hunks (for rendering highlights)
  const changeRegions = useMemo(() => buildChangeRegions(file.hunks), [file.hunks]);

  // Build scroll alignment sections (for smart synchronized scrolling)
  const rawAlignmentSections = useMemo(
    () => buildScrollAlignment(file.hunks, oldLines.length, newLines.length),
    [file.hunks, oldLines.length, newLines.length],
  );

  // Collapsible unchanged regions
  const { collapsibleRegions, expandedSet, oldHiddenRanges, newHiddenRanges, toggleRegion } =
    useCollapsedRegions(file.hunks, oldLines.length, newLines.length);

  // Adjust alignment sections to account for hidden lines
  const alignmentSections = useMemo(
    () => adjustAlignmentSections(rawAlignmentSections, oldHiddenRanges, newHiddenRanges),
    [rawAlignmentSections, oldHiddenRanges, newHiddenRanges],
  );

  // Build view zone descriptors for each collapsed (non-expanded) region
  const oldViewZones = useMemo<ViewZoneDescriptor[]>(
    () =>
      collapsibleRegions
        .filter((r) => !expandedSet.has(r.index) && r.oldStart <= r.oldEnd)
        .map((r) => ({
          afterLineNumber: r.oldStart - 1,
          heightInPx: VIEW_ZONE_HEIGHT,
          label: `${r.lineCount} hidden lines`,
          onClick: () => toggleRegion(r.index),
        })),
    [collapsibleRegions, expandedSet, toggleRegion],
  );

  const newViewZones = useMemo<ViewZoneDescriptor[]>(
    () =>
      collapsibleRegions
        .filter((r) => !expandedSet.has(r.index) && r.newStart <= r.newEnd)
        .map((r) => ({
          afterLineNumber: r.newStart - 1,
          heightInPx: VIEW_ZONE_HEIGHT,
          label: `${r.lineCount} hidden lines`,
          onClick: () => toggleRegion(r.index),
        })),
    [collapsibleRegions, expandedSet, toggleRegion],
  );

  // Detect language for Monaco
  const language = useMemo(() => toMonacoLanguage(detectLanguage(filePath)), [filePath]);

  // Join lines into content strings for Monaco
  const oldContent = useMemo(() => oldLines.join("\n"), [oldLines]);
  const newContent = useMemo(() => newLines.join("\n"), [newLines]);

  // Track editor instances for external line numbers and DiffGutter
  const [leftEditor, setLeftEditor] = useState<editor.IStandaloneCodeEditor | null>(null);
  const [rightEditor, setRightEditor] = useState<editor.IStandaloneCodeEditor | null>(null);

  // Portal targets for LineNumbersColumn overlays (rendered above DiffGutter SVG)
  const leftOverlayRef = useRef<HTMLDivElement>(null);
  const rightOverlayRef = useRef<HTMLDivElement>(null);

  // Monaco-aware scroll sync
  const {
    onLeftEditorMount: onLeftEditorMountScroll,
    onRightEditorMount: onRightEditorMountScroll,
    subscribeToScroll,
    flushScroll,
    leftContainerRef,
    rightContainerRef,
  } = useMonacoSyncScroll({ alignmentSections, lineHeight: LINE_HEIGHT });

  // Compose left editor mount: scroll sync + store instance
  const onLeftEditorMount = useCallback(
    (ed: editor.IStandaloneCodeEditor) => {
      onLeftEditorMountScroll(ed);
      setLeftEditor(ed);
    },
    [onLeftEditorMountScroll],
  );

  // Compose right editor mount: scroll sync + store instance
  const onRightEditorMount = useCallback(
    (ed: editor.IStandaloneCodeEditor) => {
      onRightEditorMountScroll(ed);
      setRightEditor(ed);
    },
    [onRightEditorMountScroll],
  );

  // --- Comment interaction state ---
  const [leftSelection, setLeftSelection] = useState<{ startLine: number; endLine: number } | null>(
    null,
  );
  const [rightSelection, setRightSelection] = useState<{
    startLine: number;
    endLine: number;
  } | null>(null);

  // Get placed threads for the current file from store (server already did relocation)
  const commentThreads = useMemo(() => {
    const threads = [...getThreadsForFile(filePath)];
    // For renamed files, also look under the old path
    if (oldPath !== filePath) {
      const oldPathThreads = getThreadsForFile(oldPath);
      const existingIds = new Set(threads.map((t) => t.id));
      for (const t of oldPathThreads) {
        if (!existingIds.has(t.id)) threads.push(t);
      }
    }
    return threads;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, oldPath, placedThreadsByFile]);

  // Handle drag selection on left line numbers — live highlight update
  const onLeftLineSelectionChange = useCallback(
    (range: { startLine: number; endLine: number } | null) => {
      setLeftSelection(range);
      if (range) setRightSelection(null);
    },
    [],
  );

  // Handle drag selection on right line numbers — live highlight update
  const onRightLineSelectionChange = useCallback(
    (range: { startLine: number; endLine: number } | null) => {
      setRightSelection(range);
      if (range) setLeftSelection(null);
    },
    [],
  );

  // Handle mouseup after line number drag-select on the left
  const onLeftLineSelect = useCallback(
    (startLine: number, endLine: number) => {
      const existing = commentThreads.find(
        (t) =>
          t.displaySide === "old" &&
          startLine === endLine &&
          startLine >= t.displayStartLine &&
          startLine <= t.displayEndLine,
      );
      if (existing) {
        setActiveThread(existing.id);
      } else {
        setPendingAnchor({ side: "old", startLine, endLine });
      }
    },
    [commentThreads, setActiveThread, setPendingAnchor],
  );

  // Handle mouseup after line number drag-select on the right
  const onRightLineSelect = useCallback(
    (startLine: number, endLine: number) => {
      const existing = commentThreads.find(
        (t) =>
          t.displaySide === "new" &&
          startLine === endLine &&
          startLine >= t.displayStartLine &&
          startLine <= t.displayEndLine,
      );
      if (existing) {
        setActiveThread(existing.id);
      } else {
        setPendingAnchor({ side: "new", startLine, endLine });
      }
    },
    [commentThreads, setActiveThread, setPendingAnchor],
  );

  // Handle selection on each editor — clear the other side so only one is active
  const onLeftSelectionChange = useCallback(
    (sel: { startLine: number; endLine: number } | null) => {
      setLeftSelection(sel);
      if (sel) setRightSelection(null);
    },
    [],
  );

  const onRightSelectionChange = useCallback(
    (sel: { startLine: number; endLine: number } | null) => {
      setRightSelection(sel);
      if (sel) setLeftSelection(null);
    },
    [],
  );

  // When user clicks the "+" button on a selection (either side)
  const onAddCommentClickLeft = useCallback(() => {
    if (leftSelection) {
      setPendingAnchor({
        side: "old",
        startLine: leftSelection.startLine,
        endLine: leftSelection.endLine,
      });
      setLeftSelection(null);
    }
  }, [leftSelection, setPendingAnchor]);

  const onAddCommentClickRight = useCallback(() => {
    if (rightSelection) {
      setPendingAnchor({
        side: "new",
        startLine: rightSelection.startLine,
        endLine: rightSelection.endLine,
      });
      setRightSelection(null);
    }
  }, [rightSelection, setPendingAnchor]);

  // Clear pending anchor when file changes
  useEffect(() => {
    setPendingAnchor(null);
    setActiveThread(null);
  }, [filePath, oldPath, setPendingAnchor, setActiveThread]);

  return (
    <div className="bg-editor-surface flex h-full flex-col">
      {/* Header with commit hashes */}
      <div className="border-border bg-muted/20 flex shrink-0 border-b text-[10px]">
        <div className="border-border flex-1 border-r px-2 py-1">
          <span className="text-foreground ml-1">{worktreePath ? "HEAD" : "Parent"}</span>
          <span className="text-muted-foreground font-mono"> ({oldRef?.slice(0, 7) ?? "..."})</span>
        </div>
        <div className="flex-1 px-2 py-1">
          <span className="text-foreground ml-1">{worktreePath ? "Working Tree" : "Current"}</span>
          {!worktreePath && (
            <span className="text-muted-foreground font-mono">
              {" "}
              ({newRef?.slice(0, 7) ?? "..."})
            </span>
          )}
        </div>
      </div>

      {/* Side-by-side panels with gutter overlay */}
      <div className="relative flex flex-1 overflow-hidden" style={{ overscrollBehavior: "none" }}>
        {isLoading ? (
          <div className="text-muted-foreground flex flex-1 items-center justify-center text-xs">
            Loading file content...
          </div>
        ) : (
          <>
            {/* Left panel - OLD file + line numbers (shared container for wheel capture) */}
            <div ref={leftContainerRef} className="relative flex flex-1 overflow-hidden">
              <div className="flex-1 overflow-hidden">
                <EditorPanel
                  content={oldContent}
                  language={language}
                  filePath={oldPath}
                  gitRef={oldRef}
                  side="old"
                  changeRegions={changeRegions.old}
                  darkMode={darkMode}
                  diagnostics={oldDiagnostics}
                  hiddenRanges={oldHiddenRanges}
                  viewZones={oldViewZones}
                  commentThreads={commentThreads}
                  selectionHighlightLines={leftSelection}
                  onSelectionChange={onLeftSelectionChange}
                  onEditorMount={onLeftEditorMount}
                />
              </div>

              {/* Floating "Add Comment" button for left (old) side — at right edge near line numbers */}
              {!pendingAnchor && (
                <AddCommentButton
                  editorInstance={leftEditor}
                  selection={leftSelection}
                  subscribeToScroll={subscribeToScroll}
                  scrollSide="left"
                  side="right"
                  onClick={onAddCommentClickLeft}
                />
              )}

              {/* Comment composer for creating new threads (shown on left side) */}
              {pendingAnchor && pendingAnchor.side === "old" && activeReviewId && (
                <CommentComposer
                  editorInstance={leftEditor}
                  subscribeToScroll={subscribeToScroll}
                  scrollSide="left"
                  reviewId={activeReviewId}
                  filePath={oldPath}
                  fileLines={oldLines}
                />
              )}

              <LineNumbersColumn
                lineCount={oldLines.length}
                changeRegions={changeRegions.old}
                lineHeight={LINE_HEIGHT}
                subscribeToScroll={subscribeToScroll}
                side="left"
                align="right"
                commentSide="old"
                editorInstance={leftEditor}
                hiddenRanges={oldHiddenRanges}
                selectionHighlightLines={leftSelection}
                commentThreads={commentThreads}
                onSelectionChange={onLeftLineSelectionChange}
                onLineSelect={onLeftLineSelect}
                overlayPortalRef={leftOverlayRef}
              />
            </div>

            {/* Center gutter with SVG connectors */}
            <DiffGutter
              pairs={changeRegions.pairs}
              leftPanelRef={leftContainerRef}
              rightPanelRef={rightContainerRef}
              lineHeight={LINE_HEIGHT}
              subscribeToScroll={subscribeToScroll}
              flushScroll={flushScroll}
              leftEditor={leftEditor}
              rightEditor={rightEditor}
              collapseRegions={collapsibleRegions}
              expandedSet={expandedSet}
              toggleRegion={toggleRegion}
            />

            {/* Overlay portal targets — rendered after DiffGutter so they paint above its SVG (z-10).
                Portaled content from LineNumbersColumn includes comment stripe patterns and icons. */}
            <div
              ref={leftOverlayRef}
              className="pointer-events-none absolute top-0 bottom-0 z-20 overflow-hidden"
              style={{ width: 64, right: "50%" }}
            />
            <div
              ref={rightOverlayRef}
              className="pointer-events-none absolute top-0 bottom-0 z-20 overflow-hidden"
              style={{ width: 64, left: "50%" }}
            />

            {/* Right panel - NEW file with custom LineNumbersColumn */}
            <div ref={rightContainerRef} className="relative flex flex-1 overflow-hidden">
              <LineNumbersColumn
                lineCount={newLines.length}
                changeRegions={changeRegions.new}
                lineHeight={LINE_HEIGHT}
                subscribeToScroll={subscribeToScroll}
                side="right"
                align="left"
                commentSide="new"
                editorInstance={rightEditor}
                hiddenRanges={newHiddenRanges}
                selectionHighlightLines={rightSelection}
                commentThreads={commentThreads}
                onSelectionChange={onRightLineSelectionChange}
                onLineSelect={onRightLineSelect}
                overlayPortalRef={rightOverlayRef}
              />
              <div className="flex-1 overflow-hidden">
                <EditorPanel
                  content={newContent}
                  language={language}
                  filePath={filePath}
                  gitRef={newRef}
                  side="new"
                  changeRegions={changeRegions.new}
                  darkMode={darkMode}
                  diagnostics={newDiagnostics}
                  hiddenRanges={newHiddenRanges}
                  viewZones={newViewZones}
                  commentThreads={commentThreads}
                  selectionHighlightLines={rightSelection}
                  onSelectionChange={onRightSelectionChange}
                  onEditorMount={onRightEditorMount}
                />
              </div>

              {/* Floating "Add Comment" button on caret/selection */}
              {!pendingAnchor && (
                <AddCommentButton
                  editorInstance={rightEditor}
                  selection={rightSelection}
                  subscribeToScroll={subscribeToScroll}
                  scrollSide="right"
                  side="left"
                  onClick={onAddCommentClickRight}
                />
              )}

              {/* Comment composer for creating new threads (shown on right side) */}
              {pendingAnchor && pendingAnchor.side === "new" && activeReviewId && (
                <CommentComposer
                  editorInstance={rightEditor}
                  subscribeToScroll={subscribeToScroll}
                  scrollSide="right"
                  reviewId={activeReviewId}
                  filePath={filePath}
                  fileLines={newLines}
                />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
