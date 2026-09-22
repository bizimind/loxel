import type { editor } from "monaco-editor";
import type { RefObject } from "react";
import { useCallback, useEffect, useRef } from "react";

import type { ScrollAlignmentSection, ScrollSide } from "@/components/diff/change-regions";
import { translateScrollPosition } from "@/components/diff/change-regions";

type IStandaloneCodeEditor = editor.IStandaloneCodeEditor;

interface UseMonacoSyncScrollOptions {
  alignmentSections: ScrollAlignmentSection[];
  lineHeight: number;
}

/** Scroll both editors by a wheel delta, treating `source` as the panel being scrolled. */
export type ScrollBy = (source: ScrollSide, deltaX: number, deltaY: number) => void;

interface UseMonacoSyncScrollResult {
  onLeftEditorMount: (editor: IStandaloneCodeEditor) => void;
  onRightEditorMount: (editor: IStandaloneCodeEditor) => void;
  subscribeToScroll: (cb: (left: number, right: number) => void) => () => void;
  /** Re-notify all scroll subscribers with current positions (e.g. after layout changes) */
  flushScroll: () => void;
  /**
   * Apply a wheel delta programmatically. Used by overlays that sit outside the panel
   * containers (e.g. the collapse indicator in DiffGutter) so they can scroll the panel
   * under the pointer without re-dispatching DOM events.
   */
  scrollBy: ScrollBy;
  leftContainerRef: RefObject<HTMLDivElement | null>;
  rightContainerRef: RefObject<HTMLDivElement | null>;
}

/**
 * Monaco-aware scroll sync hook.
 *
 * Since Monaco editors have `handleMouseWheel: false`, we intercept wheel events
 * on container divs and use `editor.setScrollTop()` / `editor.setScrollLeft()`
 * to position both editors according to the alignment sections.
 *
 * The source side matters: scroll translation is not a bijection (the follower can be
 * paused or clamped), so the source must always be the panel the user is actually
 * scrolling. Overlays outside the containers must report the side under the pointer
 * via `scrollBy` rather than forwarding to a fixed side.
 */
export function useMonacoSyncScroll(
  options: UseMonacoSyncScrollOptions,
): UseMonacoSyncScrollResult {
  const leftEditorRef = useRef<IStandaloneCodeEditor | null>(null);
  const rightEditorRef = useRef<IStandaloneCodeEditor | null>(null);
  const leftContainerRef = useRef<HTMLDivElement | null>(null);
  const rightContainerRef = useRef<HTMLDivElement | null>(null);

  // Subscribers for scroll updates (DiffGutter uses this)
  const subscribersRef = useRef<Set<(left: number, right: number) => void>>(new Set());

  const subscribeToScroll = useCallback((cb: (left: number, right: number) => void) => {
    subscribersRef.current.add(cb);
    // Call immediately with current state
    const leftScroll = leftEditorRef.current?.getScrollTop() ?? 0;
    const rightScroll = rightEditorRef.current?.getScrollTop() ?? 0;
    cb(leftScroll, rightScroll);
    return () => {
      subscribersRef.current.delete(cb);
    };
  }, []);

  const notifySubscribers = useCallback((left: number, right: number) => {
    for (const cb of subscribersRef.current) {
      cb(left, right);
    }
  }, []);

  // Core scroll logic — drives both editors from a delta on the source side
  const scrollBy = useCallback<ScrollBy>(
    (source, deltaX, deltaY) => {
      const leftEditor = leftEditorRef.current;
      const rightEditor = rightEditorRef.current;
      if (!leftEditor || !rightEditor) return;

      const sourceEditor = source === "left" ? leftEditor : rightEditor;
      const viewportHeight =
        (source === "left" ? leftContainerRef : rightContainerRef).current?.clientHeight ?? 0;

      if (viewportHeight === 0) return;

      // Vertical scrolling — alignment-based
      if (deltaY !== 0) {
        const currentScrollTop = sourceEditor.getScrollTop();
        const newSourceScroll = Math.max(0, currentScrollTop + deltaY);

        const { leftScroll, rightScroll } = translateScrollPosition(
          source,
          newSourceScroll,
          options.alignmentSections,
          options.lineHeight,
          viewportHeight,
        );

        leftEditor.setScrollTop(leftScroll);
        rightEditor.setScrollTop(rightScroll);
        // Read back clamped values — Monaco clamps internally but translateScrollPosition doesn't
        notifySubscribers(leftEditor.getScrollTop(), rightEditor.getScrollTop());
      }

      // Horizontal scrolling — mirror deltaX to both editors
      if (deltaX !== 0) {
        const sourceScrollLeft = sourceEditor.getScrollLeft();
        const newScrollLeft = Math.max(0, sourceScrollLeft + deltaX);
        leftEditor.setScrollLeft(newScrollLeft);
        rightEditor.setScrollLeft(newScrollLeft);
      }
    },
    [options.alignmentSections, options.lineHeight, notifySubscribers],
  );

  // Wheel event handler — intercepts wheel on container, drives both editors
  const handleWheel = useCallback(
    (e: WheelEvent, source: ScrollSide) => {
      e.preventDefault();
      e.stopPropagation();
      scrollBy(source, e.deltaX, e.deltaY);
    },
    [scrollBy],
  );

  // Set up wheel listeners on container divs
  useEffect(() => {
    const leftContainer = leftContainerRef.current;
    const rightContainer = rightContainerRef.current;
    if (!leftContainer || !rightContainer) return;

    const leftHandler = (e: WheelEvent) => handleWheel(e, "left");
    const rightHandler = (e: WheelEvent) => handleWheel(e, "right");

    leftContainer.addEventListener("wheel", leftHandler, { passive: false, capture: true });
    rightContainer.addEventListener("wheel", rightHandler, { passive: false, capture: true });

    return () => {
      leftContainer.removeEventListener("wheel", leftHandler, { capture: true });
      rightContainer.removeEventListener("wheel", rightHandler, { capture: true });
    };
  }, [handleWheel]);

  const flushScroll = useCallback(() => {
    const leftScroll = leftEditorRef.current?.getScrollTop() ?? 0;
    const rightScroll = rightEditorRef.current?.getScrollTop() ?? 0;
    notifySubscribers(leftScroll, rightScroll);
  }, [notifySubscribers]);

  const onLeftEditorMount = useCallback((ed: IStandaloneCodeEditor) => {
    leftEditorRef.current = ed;
  }, []);

  const onRightEditorMount = useCallback((ed: IStandaloneCodeEditor) => {
    rightEditorRef.current = ed;
  }, []);

  return {
    onLeftEditorMount,
    onRightEditorMount,
    subscribeToScroll,
    flushScroll,
    scrollBy,
    leftContainerRef,
    rightContainerRef,
  };
}
