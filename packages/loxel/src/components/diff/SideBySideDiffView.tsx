import type { Uri, editor } from "monaco-editor";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { TypeScriptDiagnostic } from "@/api/diagnostics-model";
import type { DiffHunk } from "@/api/diff-model";
import type { PlacedThread } from "@/api/review-model";
import { AddCommentButton } from "@/components/comments/AddCommentButton";
import { CommentComposer } from "@/components/comments/CommentComposer";
import { useCollapsedRegions } from "@/hooks/useCollapsedRegions";
import { useMonacoSyncScroll } from "@/hooks/useMonacoSyncScroll";
import { useCommentStore } from "@/store/comments";
import { useUIStore } from "@/store/ui";
import { useReviewStore } from "@/store/worktree-reviews";

import { buildChangeRegions, buildScrollAlignment } from "./change-regions";
import { DiffGutter } from "./DiffGutter";
import type { ViewZoneDescriptor } from "./EditorPanel";
import { EditorPanel } from "./EditorPanel";
import { buildInlineChangesForPairs } from "./inline-changes";
import { LineNumbersColumn } from "./LineNumbersColumn";
import { VIEW_ZONE_HEIGHT, adjustAlignmentSections } from "./unchanged-regions";

const LINE_HEIGHT = 22; // px per line — must match Monaco editor lineHeight

type IStandaloneCodeEditor = editor.IStandaloneCodeEditor;

/**
 * An editable side. Its editor starts from `content` (the side's live text, which keeps its line
 * endings, unlike `lines`) and reports every change; the owner then updates the editor itself
 * through `onEditorMount`.
 */
export interface EditableDiffSide {
  content: string;
  onContentChange: (value: string) => void;
}

/** One side of a side-by-side diff */
export interface DiffSide {
  /** Full content of the side, one entry per line */
  lines: string[];
  /** The side's file: repo-relative in git diffs (where comments anchor), absolute otherwise */
  filePath: string;
  /** Monaco language id */
  language: string;
  /** URI of the side's Monaco model; must be unique among mounted diff views */
  modelUri: Uri;
  /** Shown in the header above the side */
  label: ReactNode;
  diagnostics?: TypeScriptDiagnostic[];
  /** Makes the side editable in place */
  editable?: EditableDiffSide;
  /** Receives the side's editor once it is created */
  onEditorMount?: (editor: IStandaloneCodeEditor) => void;
}

interface SideBySideDiffViewProps {
  hunks: DiffHunk[];
  oldSide: DiffSide;
  newSide: DiffSide;
  isLoading?: boolean;
  /** Review comments on the diff's lines; only git diffs have them. */
  comments?: boolean;
  /** Keep expanded unchanged regions expanded when the hunks are recomputed (edited content). */
  keepExpandedOnChange?: boolean;
}

/**
 * Two Monaco editors side by side with change highlights, synchronized scrolling, collapsible
 * unchanged regions and the connector gutter between them. Content comes from the caller, so the
 * same view renders git diffs and comparisons of arbitrary files.
 */
export function SideBySideDiffView({
  hunks,
  oldSide,
  newSide,
  isLoading = false,
  comments = false,
  keepExpandedOnChange = false,
}: SideBySideDiffViewProps) {
  const darkMode = useUIStore((s) => s.darkMode);

  // Review state
  const activeReviewId = useReviewStore((s) => s.activeReviewId);

  // Comments state — server-placed threads
  const setActiveThread = useCommentStore((s) => s.setActiveThread);
  const pendingAnchor = useCommentStore((s) => s.pendingAnchor);
  const setPendingAnchor = useCommentStore((s) => s.setPendingAnchor);
  const getThreadsForFile = useCommentStore((s) => s.getThreadsForFile);
  const placedThreadsByFile = useCommentStore((s) => s.placedThreadsByFile);

  const filePath = newSide.filePath;
  const oldPath = oldSide.filePath;
  const oldLines = oldSide.lines;
  const newLines = newSide.lines;

  // Build change regions from hunks (for rendering highlights)
  const changeRegions = useMemo(() => buildChangeRegions(hunks), [hunks]);

  // Intra-line changes within modification blocks (inline red/green over the blue lines)
  const inlineChanges = useMemo(
    () => buildInlineChangesForPairs(changeRegions.pairs, oldLines, newLines),
    [changeRegions.pairs, oldLines, newLines],
  );

  // Build scroll alignment sections (for smart synchronized scrolling)
  const rawAlignmentSections = useMemo(
    () => buildScrollAlignment(hunks, oldLines.length, newLines.length),
    [hunks, oldLines.length, newLines.length],
  );

  // Collapsible unchanged regions
  const { collapsibleRegions, expandedSet, oldHiddenRanges, newHiddenRanges, toggleRegion } =
    useCollapsedRegions(hunks, oldLines.length, newLines.length, { keepExpandedOnChange });

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
    scrollBy,
    leftContainerRef,
    rightContainerRef,
  } = useMonacoSyncScroll({ alignmentSections, lineHeight: LINE_HEIGHT });

  // Compose editor mounts: scroll sync + store instance + the caller's callback
  const onOldSideMountRef = useRef(oldSide.onEditorMount);
  onOldSideMountRef.current = oldSide.onEditorMount;
  const onNewSideMountRef = useRef(newSide.onEditorMount);
  onNewSideMountRef.current = newSide.onEditorMount;

  const onLeftEditorMount = useCallback(
    (ed: IStandaloneCodeEditor) => {
      onLeftEditorMountScroll(ed);
      setLeftEditor(ed);
      onOldSideMountRef.current?.(ed);
    },
    [onLeftEditorMountScroll],
  );

  const onRightEditorMount = useCallback(
    (ed: IStandaloneCodeEditor) => {
      onRightEditorMountScroll(ed);
      setRightEditor(ed);
      onNewSideMountRef.current?.(ed);
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
  const commentThreads = useMemo<PlacedThread[]>(() => {
    if (!comments) return [];
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
  }, [comments, filePath, oldPath, placedThreadsByFile]);

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
    if (!comments) return;
    setPendingAnchor(null);
    setActiveThread(null);
  }, [comments, filePath, oldPath, setPendingAnchor, setActiveThread]);

  return (
    <div className="bg-editor-surface flex h-full flex-col">
      <div className="border-border bg-muted/20 flex shrink-0 border-b text-[10px]">
        <div className="border-border min-w-0 flex-1 truncate border-r px-2 py-1">
          {oldSide.label}
        </div>
        <div className="min-w-0 flex-1 truncate px-2 py-1">{newSide.label}</div>
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
                  content={oldSide.editable?.content ?? oldContent}
                  language={oldSide.language}
                  modelUri={oldSide.modelUri}
                  side="old"
                  onContentChange={oldSide.editable?.onContentChange}
                  changeRegions={changeRegions.old}
                  inlineChanges={inlineChanges.old}
                  darkMode={darkMode}
                  diagnostics={oldSide.diagnostics}
                  hiddenRanges={oldHiddenRanges}
                  viewZones={oldViewZones}
                  commentThreads={commentThreads}
                  selectionHighlightLines={leftSelection}
                  onSelectionChange={comments ? onLeftSelectionChange : undefined}
                  onEditorMount={onLeftEditorMount}
                />
              </div>

              {/* Floating "Add Comment" button for left (old) side — at right edge near line numbers */}
              {comments && !pendingAnchor && (
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
              {comments && pendingAnchor?.side === "old" && activeReviewId && (
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
                onSelectionChange={comments ? onLeftLineSelectionChange : undefined}
                onLineSelect={comments ? onLeftLineSelect : undefined}
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
              scrollBy={scrollBy}
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
                onSelectionChange={comments ? onRightLineSelectionChange : undefined}
                onLineSelect={comments ? onRightLineSelect : undefined}
                overlayPortalRef={rightOverlayRef}
              />
              <div className="flex-1 overflow-hidden">
                <EditorPanel
                  content={newSide.editable?.content ?? newContent}
                  language={newSide.language}
                  modelUri={newSide.modelUri}
                  side="new"
                  onContentChange={newSide.editable?.onContentChange}
                  changeRegions={changeRegions.new}
                  inlineChanges={inlineChanges.new}
                  darkMode={darkMode}
                  diagnostics={newSide.diagnostics}
                  hiddenRanges={newHiddenRanges}
                  viewZones={newViewZones}
                  commentThreads={commentThreads}
                  selectionHighlightLines={rightSelection}
                  onSelectionChange={comments ? onRightSelectionChange : undefined}
                  onEditorMount={onRightEditorMount}
                />
              </div>

              {/* Floating "Add Comment" button on caret/selection */}
              {comments && !pendingAnchor && (
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
              {comments && pendingAnchor?.side === "new" && activeReviewId && (
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
