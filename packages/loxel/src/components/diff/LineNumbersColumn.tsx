import type { editor } from "monaco-editor";

import { MessageSquareCheckIcon, MessageSquareDotIcon, MessageSquarePlusIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { PlacedThread } from "@/api/review-model";

import { cn } from "@/lib/utils";

import type { ChangeRegion } from "./change-regions";
import type { LineRange } from "./unchanged-regions";

import { buildLineChangeMap } from "./change-regions";
import { VIEW_ZONE_HEIGHT } from "./unchanged-regions";

type IStandaloneCodeEditor = editor.IStandaloneCodeEditor;

interface LineNumbersColumnProps {
  lineCount: number;
  changeRegions: ChangeRegion[];
  lineHeight: number;
  /** Subscribe to scroll updates — callback receives (leftScroll, rightScroll) */
  subscribeToScroll: (cb: (left: number, right: number) => void) => () => void;
  /** Which scroll value to use for positioning */
  side: "left" | "right";
  /** Visual alignment — "left" puts border on right, "right" puts border on left */
  align?: "left" | "right";
  /** Which comment side to filter threads by */
  commentSide?: "old" | "new";
  /** The associated Monaco editor (for tracking cursor position) */
  editorInstance: IStandaloneCodeEditor | null;
  /** Hidden line ranges (collapsed unchanged regions) */
  hiddenRanges?: LineRange[];
  /** Lines to highlight as the current selection (for comment anchoring feedback) */
  selectionHighlightLines?: { startLine: number; endLine: number } | null;
  /** Placed comment threads to show indicators for */
  commentThreads?: PlacedThread[];
  /** Called during drag to update live selection highlight */
  onSelectionChange?: (range: { startLine: number; endLine: number } | null) => void;
  /** Called on mouseup after a line drag-select completes */
  onLineSelect?: (startLine: number, endLine: number) => void;
  /** Portal target for the overlay layer (stripes + icons), rendered above DiffGutter SVG */
  overlayPortalRef?: React.RefObject<HTMLDivElement | null>;
}

/**
 * Custom line numbers column rendered outside of Monaco, used on both sides of the diff.
 * Scroll is synced via subscribeToScroll using CSS transform for zero-lag updates.
 *
 * Renders two layers:
 * 1. The column div with line numbers and backgrounds (inside overflow-hidden scroll container)
 * 2. An overlay div with comment icons and stripe patterns (z-20, above DiffGutter SVG)
 *
 * The overlay is a sibling (not child) of the scroll container because will-change-transform
 * on the scroll div creates an isolated stacking context that traps z-index values.
 */
export function LineNumbersColumn({
  lineCount,
  changeRegions,
  lineHeight,
  subscribeToScroll,
  side,
  align = "left",
  commentSide = "old",
  editorInstance,
  hiddenRanges,
  selectionHighlightLines,
  commentThreads,
  onSelectionChange,
  onLineSelect,
  overlayPortalRef,
}: LineNumbersColumnProps) {
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const overlayInnerRef = useRef<HTMLDivElement>(null);
  const lineChangeMap = useMemo(() => buildLineChangeMap(changeRegions), [changeRegions]);
  const [activeLine, setActiveLine] = useState<number | null>(null);
  const [hoveredLine, setHoveredLine] = useState<number | null>(null);

  // Drag-to-select state
  const dragAnchorRef = useRef<number | null>(null);
  const dragCurrentRef = useRef<number | null>(null);
  const onSelectionChangeRef = useRef(onSelectionChange);
  onSelectionChangeRef.current = onSelectionChange;
  const onLineSelectRef = useRef(onLineSelect);
  onLineSelectRef.current = onLineSelect;

  const getDragRange = useCallback((anchor: number, current: number) => {
    const startLine = Math.min(anchor, current);
    const endLine = Math.max(anchor, current);
    return { startLine, endLine };
  }, []);

  const handleMouseDown = useCallback((lineNum: number) => {
    dragAnchorRef.current = lineNum;
    dragCurrentRef.current = lineNum;
    onSelectionChangeRef.current?.({ startLine: lineNum, endLine: lineNum });
  }, []);

  const handleMouseEnterDrag = useCallback(
    (lineNum: number) => {
      if (dragAnchorRef.current === null) return;
      dragCurrentRef.current = lineNum;
      onSelectionChangeRef.current?.(getDragRange(dragAnchorRef.current, lineNum));
    },
    [getDragRange],
  );

  // Listen for mouseup on window to finalize drag
  useEffect(() => {
    const handleMouseUp = () => {
      const anchor = dragAnchorRef.current;
      const current = dragCurrentRef.current;
      if (anchor !== null && current !== null) {
        const { startLine, endLine } = getDragRange(anchor, current);
        onLineSelectRef.current?.(startLine, endLine);
      }
      dragAnchorRef.current = null;
      dragCurrentRef.current = null;
    };
    window.addEventListener("mouseup", handleMouseUp);
    return () => window.removeEventListener("mouseup", handleMouseUp);
  }, [getDragRange]);

  // Build a set of lines that have comment threads for this side, and a map of first-lines
  const { commentLineSet, commentFirstLines, resolvedLineSet } = useMemo(() => {
    const lineSet = new Set<number>();
    const firstLines = new Set<number>();
    const resolved = new Set<number>();
    if (commentThreads) {
      for (const t of commentThreads) {
        if (t.displaySide !== commentSide) continue;
        firstLines.add(t.displayStartLine);
        for (let i = t.displayStartLine; i <= t.displayEndLine; i++) {
          lineSet.add(i);
          if (t.status === "resolved") resolved.add(i);
        }
      }
    }
    return { commentLineSet: lineSet, commentFirstLines: firstLines, resolvedLineSet: resolved };
  }, [commentThreads, commentSide]);

  // Build set of hidden lines and sorted view zone insertion points
  const { hiddenSet, viewZoneAfterLines } = useMemo(() => {
    const set = new Set<number>();
    const afterLines: number[] = [];
    if (hiddenRanges) {
      for (const r of hiddenRanges) {
        for (let i = r.startLineNumber; i <= r.endLineNumber; i++) set.add(i);
        afterLines.push(r.startLineNumber - 1);
      }
    }
    afterLines.sort((a, b) => a - b);
    return { hiddenSet: set, viewZoneAfterLines: afterLines };
  }, [hiddenRanges]);

  // Track cursor position for active line highlighting
  useEffect(() => {
    if (!editorInstance) return;
    const disposable = editorInstance.onDidChangeCursorPosition((e) => {
      setActiveLine(e.position.lineNumber);
    });
    return () => disposable.dispose();
  }, [editorInstance]);

  // Sync scroll position via CSS transform for both the column and the overlay
  useEffect(() => {
    return subscribeToScroll((leftScroll, rightScroll) => {
      const outer = outerRef.current;
      const inner = innerRef.current;
      const overlayInner = overlayInnerRef.current;
      if (!outer || !inner) return;
      const scrollTop = side === "left" ? leftScroll : rightScroll;
      const visibleLines = lineCount - hiddenSet.size;
      const bottomPadding = lineHeight * 8; // match Monaco editor bottom padding
      const totalHeight =
        visibleLines * lineHeight + viewZoneAfterLines.length * VIEW_ZONE_HEIGHT + bottomPadding;
      const maxScroll = Math.max(0, totalHeight - outer.clientHeight);
      const clamped = Math.min(Math.max(0, scrollTop), maxScroll);
      const transform = `translateY(${-clamped}px)`;
      inner.style.transform = transform;
      if (overlayInner) overlayInner.style.transform = transform;
    });
  }, [subscribeToScroll, side, lineCount, lineHeight, hiddenSet.size, viewZoneAfterLines.length]);

  if (lineCount === 0) return null;

  // Build visible line elements and overlay elements in a single pass
  const lineElements: React.ReactNode[] = [];
  const overlayElements: React.ReactNode[] = [];
  let vzIdx = 0;
  for (let lineNum = 1; lineNum <= lineCount; lineNum++) {
    // Insert view zone spacer before hidden range
    if (vzIdx < viewZoneAfterLines.length && viewZoneAfterLines[vzIdx] === lineNum - 1) {
      lineElements.push(
        <div
          key={`vz-${lineNum}`}
          className="bg-muted border-border border-y"
          style={{ height: VIEW_ZONE_HEIGHT }}
        />,
      );
      overlayElements.push(<div key={`vz-${lineNum}`} style={{ height: VIEW_ZONE_HEIGHT }} />);
      vzIdx++;
    }

    if (hiddenSet.has(lineNum)) continue;

    const changeType = lineChangeMap.get(lineNum);
    const isActive = lineNum === activeLine;
    const isSelected =
      selectionHighlightLines &&
      lineNum >= selectionHighlightLines.startLine &&
      lineNum <= selectionHighlightLines.endLine;
    const hasComment = commentLineSet.has(lineNum);
    const isResolved = resolvedLineSet.has(lineNum);
    const isCommentFirst = commentFirstLines.has(lineNum);
    const isHovered = lineNum === hoveredLine;

    let bgClass = "";
    if (isSelected) {
      bgClass = "bg-primary";
    } else if (hasComment) {
      bgClass = isResolved ? "bg-[var(--comment-bg-resolved)]" : "bg-[var(--comment-bg)]";
    }

    // Main line element (numbers, backgrounds, interaction handlers)
    lineElements.push(
      <div
        key={lineNum}
        className={cn(
          "relative flex items-center font-mono text-xs leading-none select-none",
          bgClass,
          gutterColorClass(changeType, isActive),
          onLineSelect && "cursor-pointer",
        )}
        style={{ height: lineHeight, lineHeight: `${lineHeight}px` }}
        onMouseEnter={() => {
          setHoveredLine(lineNum);
          handleMouseEnterDrag(lineNum);
        }}
        onMouseLeave={() => setHoveredLine(null)}
        onMouseDown={onLineSelect ? () => handleMouseDown(lineNum) : undefined}
      >
        <span className={cn("flex-1 px-4", align === "right" ? "text-left" : "text-right")}>
          {lineNum}
        </span>
      </div>,
    );

    // Overlay element (stripes + icons — rendered above DiffGutter SVG via z-20)
    const hasOverlay = hasComment || isCommentFirst || (isHovered && onLineSelect);
    overlayElements.push(
      <div
        key={lineNum}
        className={cn(
          "relative flex items-center",
          hasComment &&
            !isSelected &&
            (isResolved ? "line-comment-stripe-resolved" : "line-comment-stripe"),
        )}
        style={{ height: lineHeight }}
      >
        {/* Comment indicator icon */}
        {isCommentFirst && (
          <div
            className={cn(
              "absolute top-1/2 mx-px flex size-5 -translate-y-1/2 items-center justify-center",
              align === "right" ? "right-0" : "left-0",
            )}
          >
            {isResolved ? (
              <MessageSquareCheckIcon
                style={{ width: 14, height: 14, color: "var(--muted-foreground)" }}
              />
            ) : (
              <MessageSquareDotIcon
                style={{ width: 14, height: 14, color: "var(--comment-marker)" }}
              />
            )}
          </div>
        )}
        {/* Hover affordance icon */}
        {isHovered && !isCommentFirst && onLineSelect && (
          <div
            className={cn(
              "absolute top-1/2 mx-px flex size-5 -translate-y-1/2 items-center justify-center",
              align === "right" ? "right-0" : "left-0",
            )}
          >
            <MessageSquarePlusIcon style={{ width: 14, height: 14, color: "var(--foreground)" }} />
          </div>
        )}
      </div>,
    );

    void hasOverlay; // used in overlay condition above
  }
  // Handle view zone at end of file (afterLineNumber === lineCount)
  if (vzIdx < viewZoneAfterLines.length && viewZoneAfterLines[vzIdx] === lineCount) {
    lineElements.push(
      <div
        key="vz-end"
        className="bg-muted border-border border-y"
        style={{ height: VIEW_ZONE_HEIGHT }}
      />,
    );
    overlayElements.push(<div key="vz-end" style={{ height: VIEW_ZONE_HEIGHT }} />);
  }

  const overlayContent = (
    <div ref={overlayInnerRef} className="will-change-transform">
      {overlayElements}
    </div>
  );

  return (
    <>
      <div
        ref={outerRef}
        className={cn(
          "bg-editor-surface shrink-0 overflow-hidden",
          align === "right" ? "border-l" : "border-r",
        )}
        style={{ width: 64, borderColor: "#303438" }}
      >
        <div ref={innerRef} className="will-change-transform">
          {lineElements}
        </div>
      </div>
      {/* Overlay (stripes + icons) portaled to a container above DiffGutter SVG */}
      {overlayPortalRef?.current && createPortal(overlayContent, overlayPortalRef.current)}
    </>
  );
}

function gutterColorClass(
  changeType: "add" | "delete" | "modify" | undefined,
  isActive: boolean,
): string {
  if (changeType === "add") return "text-diff-add-text";
  if (changeType === "delete") return "text-diff-del-text";
  if (changeType === "modify") return "text-diff-modify-text";
  return isActive ? "text-editor-line-number-active" : "text-editor-line-number";
}
