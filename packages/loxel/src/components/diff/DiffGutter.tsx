import type { editor } from "monaco-editor";
import type { RefObject } from "react";

import { useEffect, useRef } from "react";

import { cn } from "@/lib/utils";

import type { ChangePair } from "./change-regions";
import type { CollapsibleRegion } from "./unchanged-regions";

import { VIEW_ZONE_HEIGHT } from "./unchanged-regions";

type IStandaloneCodeEditor = editor.IStandaloneCodeEditor;

/** Width of the custom LineNumbersColumn (left panel) */
const LINE_NUM_COL_WIDTH = 64;

interface DiffGutterProps {
  pairs: ChangePair[];
  leftPanelRef: RefObject<HTMLDivElement | null>;
  rightPanelRef: RefObject<HTMLDivElement | null>;
  lineHeight: number;
  /** Subscribe to scroll updates for direct DOM manipulation (no re-renders) */
  subscribeToScroll: (callback: (left: number, right: number) => void) => () => void;
  /** Re-notify scroll subscribers after layout changes */
  flushScroll: () => void;
  /** Editor instances for getTopForLineNumber (accounts for hidden areas) */
  leftEditor: IStandaloneCodeEditor | null;
  rightEditor: IStandaloneCodeEditor | null;
  /** Collapsed regions for squiggly line connectors */
  collapseRegions: CollapsibleRegion[];
  expandedSet: Set<number>;
  toggleRegion: (index: number) => void;
}

/**
 * Build a curved connector path between left and right change regions.
 * Creates a filled shape connecting the old (left) region to the new (right) region.
 */
function buildConnectorPath(
  x1: number,
  y1Top: number,
  y1Bottom: number,
  x2: number,
  y2Top: number,
  y2Bottom: number,
): string {
  const cx = (x1 + x2) / 2; // Control point X (middle of gutter)

  // Bezier curves from left region to right region
  return `
    M ${x1} ${y1Top}
    C ${cx} ${y1Top}, ${cx} ${y2Top}, ${x2} ${y2Top}
    L ${x2} ${y2Bottom}
    C ${cx} ${y2Bottom}, ${cx} ${y1Bottom}, ${x1} ${y1Bottom}
    Z
  `;
}

/** How far left/right the squiggly line extends beyond the gutter into each panel */
const SQUIGGLY_EXTEND = 3000;
const SQUIGGLY_AMPLITUDE = 5;
const SQUIGGLY_HALF_WAVE = 10; // half wavelength in px

/** Build a horizontal wavy segment from xStart to xEnd at a fixed baseY */
function buildWavySegment(xStart: number, xEnd: number, baseY: number, move: boolean): string {
  if (xEnd <= xStart) return move ? `M ${xStart} ${baseY}` : "";
  const width = xEnd - xStart;
  const segments = Math.max(4, Math.round(width / SQUIGGLY_HALF_WAVE));
  const segWidth = width / segments;
  let d = move ? `M ${xStart} ${baseY}` : "";
  for (let i = 0; i < segments; i++) {
    const direction = i % 2 === 0 ? 1 : -1;
    const cpX = xStart + (i + 0.5) * segWidth;
    const cpY = baseY + SQUIGGLY_AMPLITUDE * direction;
    const endX = xStart + (i + 1) * segWidth;
    d += ` Q ${cpX} ${cpY}, ${endX} ${baseY}`;
  }
  return d;
}

/** Estimate SVG text width for a label string at 10px Inter */
function estimateTextWidth(label: string): number {
  return label.length * 5.5 + 16;
}

/**
 * Build a full-width collapse indicator path with gaps for text labels.
 * Five segments: left wavy (with gap) → gutter curve → right wavy (with gap).
 */
function buildCollapsePath(
  gutterWidth: number,
  leftY: number,
  rightY: number,
  leftGapCenter: number,
  rightGapCenter: number,
  gapHalfWidth: number,
): string {
  const leftGapStart = leftGapCenter - gapHalfWidth;
  const leftGapEnd = leftGapCenter + gapHalfWidth;
  const rightGapStart = rightGapCenter - gapHalfWidth;
  const rightGapEnd = rightGapCenter + gapHalfWidth;

  // Left panel: wavy with gap for text
  let d = buildWavySegment(-SQUIGGLY_EXTEND, leftGapStart, leftY, true);
  d += buildWavySegment(leftGapEnd, 0, leftY, true);

  // Gutter: smooth bezier curve
  const cx = gutterWidth / 2;
  d += ` C ${cx} ${leftY}, ${cx} ${rightY}, ${gutterWidth} ${rightY}`;

  // Right panel: wavy with gap for text
  d += buildWavySegment(gutterWidth, rightGapStart, rightY, false);
  d += buildWavySegment(rightGapEnd, gutterWidth + SQUIGGLY_EXTEND, rightY, true);

  return d;
}

// Thin line height for insertion/deletion points (in pixels)
const THIN_LINE_HEIGHT = 2;
// Marker line extends across the full panel width
const MARKER_LINE_LENGTH = 2000;
const MARKER_LINE_HEIGHT = 2;

/**
 * DiffGutter renders SVG connectors between change regions and squiggly lines
 * for collapsed unchanged regions.
 *
 * Rendered as a zero-width flex child between LineNumbersColumn and the right editor.
 * The SVG extends left (covering LineNumbersColumn) and right (covering Monaco's gutter)
 * using absolute positioning with overflow: visible.
 *
 * Uses direct DOM manipulation via subscribeToScroll to avoid React re-renders
 * during scrolling. The SVG paths are updated directly when scroll positions change.
 */
export function DiffGutter({
  pairs,
  leftPanelRef,
  rightPanelRef,
  lineHeight,
  subscribeToScroll,
  flushScroll,
  leftEditor,
  rightEditor,
  collapseRegions,
  expandedSet,
  toggleRegion,
}: DiffGutterProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const gutterWidth = LINE_NUM_COL_WIDTH * 2; // 128px — both custom LineNumbersColumns

  // Filter to non-expanded collapse regions for rendering
  const visibleCollapseRegions = collapseRegions.filter((r) => !expandedSet.has(r.index));

  // Subscribe to scroll updates and update SVG directly (no React re-render)
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    const updateConnectors = (leftScroll: number, rightScroll: number) => {
      const leftHeight = leftPanelRef.current?.clientHeight ?? 0;
      const rightHeight = rightPanelRef.current?.clientHeight ?? 0;
      const viewportHeight = Math.max(leftHeight, rightHeight, 400);

      // Helper: get Y position for a line, using editor.getTopForLineNumber when available
      // (accounts for hidden areas and view zones), falling back to simple arithmetic
      const oldTop = (line: number) =>
        leftEditor ? leftEditor.getTopForLineNumber(line) : (line - 1) * lineHeight;
      const oldBottom = (line: number) => oldTop(line) + lineHeight;
      const newTop = (line: number) =>
        rightEditor ? rightEditor.getTopForLineNumber(line) : (line - 1) * lineHeight;
      const newBottom = (line: number) => newTop(line) + lineHeight;

      // Update change pair connectors
      const pairGroups = svg.querySelectorAll<SVGGElement>("g[data-pair-index]");
      pairGroups.forEach((group) => {
        const index = Number.parseInt(group.dataset.pairIndex ?? "0", 10);
        const pair = pairs[index];
        if (!pair) return;

        // Calculate Y positions in viewport coordinates
        let oldTopY: number;
        let oldBottomY: number;
        let newTopY: number;
        let newBottomY: number;

        if (pair.type === "add") {
          const insertionY = oldTop(pair.oldStart) - leftScroll;
          oldTopY = insertionY - THIN_LINE_HEIGHT / 2;
          oldBottomY = insertionY + THIN_LINE_HEIGHT / 2;
          newTopY = newTop(pair.newStart) - rightScroll;
          newBottomY = newBottom(pair.newEnd) - rightScroll;
        } else if (pair.type === "delete") {
          const deletionY = newTop(pair.newStart) - rightScroll;
          oldTopY = oldTop(pair.oldStart) - leftScroll;
          oldBottomY = oldBottom(pair.oldEnd) - leftScroll;
          newTopY = deletionY - THIN_LINE_HEIGHT / 2;
          newBottomY = deletionY + THIN_LINE_HEIGHT / 2;
        } else {
          oldTopY = oldTop(pair.oldStart) - leftScroll;
          oldBottomY = oldBottom(pair.oldEnd) - leftScroll;
          newTopY = newTop(pair.newStart) - rightScroll;
          newBottomY = newBottom(pair.newEnd) - rightScroll;
        }

        // Check visibility
        const isVisible =
          (oldTopY < viewportHeight && oldBottomY > 0) ||
          (newTopY < viewportHeight && newBottomY > 0);

        // Update visibility
        group.style.display = isVisible ? "" : "none";

        if (isVisible) {
          // Update path
          const path = group.querySelector("path");
          if (path) {
            path.setAttribute(
              "d",
              buildConnectorPath(0, oldTopY, oldBottomY, gutterWidth, newTopY, newBottomY),
            );
          }

          // Update marker rect position
          const rect = group.querySelector("rect");
          if (rect) {
            const markerY =
              pair.type === "add" ? (oldTopY + oldBottomY) / 2 : (newTopY + newBottomY) / 2;
            rect.setAttribute("y", String(markerY - MARKER_LINE_HEIGHT / 2));
          }
        }
      });

      // Update collapse squiggly line connectors
      const collapseGroups = svg.querySelectorAll<SVGGElement>("g[data-collapse-index]");
      collapseGroups.forEach((group) => {
        const index = Number.parseInt(group.dataset.collapseIndex ?? "0", 10);
        const region = collapseRegions.find((r) => r.index === index);
        if (!region) return;

        // Y = center of the view zone spacer at the collapse boundary.
        // View zone is placed afterLineNumber = (oldStart - 1).
        // For top-of-file collapses (afterLineNumber=0), the view zone sits at Y=0.
        // Otherwise, it sits right after the last visible line before the gap.
        let leftY: number;
        if (region.oldStart <= 1) {
          leftY = VIEW_ZONE_HEIGHT / 2 - leftScroll;
        } else {
          leftY = oldBottom(region.oldStart - 1) - leftScroll + VIEW_ZONE_HEIGHT / 2;
        }
        let rightY: number;
        if (region.newStart <= 1) {
          rightY = VIEW_ZONE_HEIGHT / 2 - rightScroll;
        } else {
          rightY = newBottom(region.newStart - 1) - rightScroll + VIEW_ZONE_HEIGHT / 2;
        }

        // Check visibility
        const isVisible =
          (leftY > -VIEW_ZONE_HEIGHT && leftY < viewportHeight + VIEW_ZONE_HEIGHT) ||
          (rightY > -VIEW_ZONE_HEIGHT && rightY < viewportHeight + VIEW_ZONE_HEIGHT);

        group.style.display = isVisible ? "" : "none";

        if (isVisible) {
          // Compute panel centers in SVG coordinates for text gap positioning
          const leftPanelW = leftPanelRef.current?.clientWidth ?? 400;
          const rightPanelW = rightPanelRef.current?.clientWidth ?? 400;
          const leftEditorW = leftPanelW - LINE_NUM_COL_WIDTH;
          const leftCenterX = -(leftEditorW / 2);
          const rightContentW = rightPanelW - LINE_NUM_COL_WIDTH;
          const rightCenterX = gutterWidth + rightContentW / 2;

          // Text gap width
          const label = `${region.lineCount} hidden lines`;
          const gapHalfW = estimateTextWidth(label) / 2;

          // Update collapse path — wavy in panels with gaps, smooth curve through gutter
          const paths = group.querySelectorAll("path");
          const collapseD = buildCollapsePath(
            gutterWidth,
            leftY,
            rightY,
            leftCenterX,
            rightCenterX,
            gapHalfW,
          );
          // paths[0] = visible line, paths[1] = invisible hit area
          if (paths[0]) paths[0].setAttribute("d", collapseD);
          if (paths[1]) paths[1].setAttribute("d", collapseD);

          // Update highlight band positions
          const rects = group.querySelectorAll<SVGRectElement>("rect.collapse-highlight");
          if (rects[0]) rects[0].setAttribute("y", String(leftY - VIEW_ZONE_HEIGHT / 2));
          if (rects[1]) rects[1].setAttribute("y", String(rightY - VIEW_ZONE_HEIGHT / 2));

          // Update text label positions
          const texts = group.querySelectorAll<SVGTextElement>("text.collapse-label");
          if (texts[0]) {
            texts[0].setAttribute("x", String(leftCenterX));
            texts[0].setAttribute("y", String(leftY));
          }
          if (texts[1]) {
            texts[1].setAttribute("x", String(rightCenterX));
            texts[1].setAttribute("y", String(rightY));
          }
        }
      });
    };

    // Subscribe and get unsubscribe function
    const unsubscribe = subscribeToScroll(updateConnectors);

    return unsubscribe;
  }, [
    pairs,
    leftPanelRef,
    rightPanelRef,
    lineHeight,
    gutterWidth,
    subscribeToScroll,
    leftEditor,
    rightEditor,
    collapseRegions,
  ]);

  // After expand/collapse, Monaco updates hidden areas and view zones asynchronously.
  // Flush scroll subscribers after a frame so connectors reposition with the new layout.
  useEffect(() => {
    const raf = requestAnimationFrame(() => flushScroll());
    return () => cancelAnimationFrame(raf);
  }, [expandedSet, flushScroll]);

  // Delegated click handler for collapse connectors
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const handleClick = (e: MouseEvent) => {
      const group = (e.target as Element).closest("g[data-collapse-index]");
      if (!group) return;
      const index = Number.parseInt((group as HTMLElement).dataset.collapseIndex ?? "", 10);
      if (!Number.isNaN(index)) toggleRegion(index);
    };
    svg.addEventListener("click", handleClick);
    return () => svg.removeEventListener("click", handleClick);
  }, [toggleRegion]);

  // Forward wheel events from collapse connectors to the editor panel so scrolling
  // doesn't stall when the mouse is over a "hidden lines" squiggly indicator
  useEffect(() => {
    const svg = svgRef.current;
    const target = leftPanelRef.current;
    if (!svg || !target) return;
    const handleWheel = (e: WheelEvent) => {
      target.dispatchEvent(new WheelEvent("wheel", e));
    };
    svg.addEventListener("wheel", handleWheel, { passive: true });
    return () => svg.removeEventListener("wheel", handleWheel);
  }, [leftPanelRef]);

  return (
    <div className="pointer-events-none relative z-10 w-0 shrink-0">
      <svg
        ref={svgRef}
        className="absolute top-0 bottom-0 overflow-visible"
        style={{ left: -LINE_NUM_COL_WIDTH, width: gutterWidth }}
        width={gutterWidth}
        height="100%"
      >
        {/* Change pair connectors */}
        {pairs.map((pair, i) => (
          <g key={i} data-pair-index={i}>
            {/* Main connector path - d attribute updated via DOM */}
            <path
              d=""
              className={cn(
                "fill-current",
                pair.type === "delete" && "text-diff-del-gutter",
                pair.type === "add" && "text-diff-add-gutter",
                pair.type === "modify" && "text-diff-modify-gutter",
              )}
            />
            {/* Marker line for insertions/deletions - y attribute updated via DOM */}
            {(pair.type === "add" || pair.type === "delete") && (
              <rect
                x={pair.type === "add" ? -MARKER_LINE_LENGTH : gutterWidth}
                y={0}
                width={MARKER_LINE_LENGTH}
                height={MARKER_LINE_HEIGHT}
                className={cn(
                  pair.type === "add" && "fill-diff-add-gutter",
                  pair.type === "delete" && "fill-diff-del-gutter",
                )}
              />
            )}
          </g>
        ))}

        {/* Collapse squiggly line connectors */}
        {visibleCollapseRegions.map((r) => (
          <g
            key={`collapse-${r.index}`}
            data-collapse-index={r.index}
            className="collapse-connector"
            style={{ pointerEvents: "all", cursor: "pointer" }}
          >
            <title>{r.lineCount} hidden lines</title>
            {/* Hover highlight bands */}
            <rect
              className="collapse-highlight"
              x={-SQUIGGLY_EXTEND}
              y={0}
              width={SQUIGGLY_EXTEND}
              height={VIEW_ZONE_HEIGHT}
              opacity={0}
            />
            <rect
              className="collapse-highlight"
              x={gutterWidth}
              y={0}
              width={SQUIGGLY_EXTEND}
              height={VIEW_ZONE_HEIGHT}
              opacity={0}
            />
            {/* Visible squiggly wave */}
            <path
              d=""
              className="collapse-squiggly"
              fill="none"
              stroke="var(--diff-collapse-line)"
              strokeWidth={1.5}
            />
            {/* Invisible wider hit area for easy clicking */}
            <path d="" fill="none" stroke="transparent" strokeWidth={14} />
            {/* Centered text labels — positioned via DOM in scroll callback */}
            <text
              className="collapse-label"
              x={0}
              y={0}
              textAnchor="middle"
              dominantBaseline="central"
              fill="var(--diff-collapse-line)"
              fontSize={10}
              fontFamily="Inter, system-ui, sans-serif"
            >
              {r.lineCount} hidden lines
            </text>
            <text
              className="collapse-label"
              x={0}
              y={0}
              textAnchor="middle"
              dominantBaseline="central"
              fill="var(--diff-collapse-line)"
              fontSize={10}
              fontFamily="Inter, system-ui, sans-serif"
            >
              {r.lineCount} hidden lines
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}
