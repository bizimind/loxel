import type { editor } from "monaco-editor";
import type { RefCallback, RefObject } from "react";
import { useCallback, useRef } from "react";

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
  /** Ref for the left panel container, whose wheel events scroll both editors */
  leftContainer: RefCallback<HTMLDivElement>;
  /** Ref for the right panel container, whose wheel events scroll both editors */
  rightContainer: RefCallback<HTMLDivElement>;
  /** The mounted left panel container, for reading its size */
  leftContainerRef: RefObject<HTMLDivElement | null>;
  /** The mounted right panel container, for reading its size */
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
 *
 * An editor can also scroll itself: Monaco reveals the caret when it moves off screen
 * (typing in an editable side, keyboard navigation). Such scrolls of the focused editor are
 * treated as the user scrolling that side, and the other side follows.
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

  // Set while this hook moves the editors, so their scroll events are not taken for the
  // editor scrolling itself.
  const syncingRef = useRef(false);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  /** Position both editors for `source` at `sourceScroll`, then notify subscribers. */
  const alignTo = useCallback(
    (source: ScrollSide, sourceScroll: number) => {
      const leftEditor = leftEditorRef.current;
      const rightEditor = rightEditorRef.current;
      if (!leftEditor || !rightEditor) return;
      const viewportHeight =
        (source === "left" ? leftContainerRef : rightContainerRef).current?.clientHeight ?? 0;
      if (viewportHeight === 0) return;

      const { leftScroll, rightScroll } = translateScrollPosition(
        source,
        sourceScroll,
        optionsRef.current.alignmentSections,
        optionsRef.current.lineHeight,
        viewportHeight,
      );
      syncingRef.current = true;
      try {
        leftEditor.setScrollTop(leftScroll);
        rightEditor.setScrollTop(rightScroll);
      } finally {
        syncingRef.current = false;
      }
      // Read back clamped values — Monaco clamps internally but translateScrollPosition doesn't
      notifySubscribers(leftEditor.getScrollTop(), rightEditor.getScrollTop());
    },
    [notifySubscribers],
  );

  // Core scroll logic — drives both editors from a delta on the source side
  const scrollBy = useCallback<ScrollBy>(
    (source, deltaX, deltaY) => {
      const leftEditor = leftEditorRef.current;
      const rightEditor = rightEditorRef.current;
      if (!leftEditor || !rightEditor) return;

      const sourceEditor = source === "left" ? leftEditor : rightEditor;

      // Vertical scrolling — alignment-based
      if (deltaY !== 0) {
        alignTo(source, Math.max(0, sourceEditor.getScrollTop() + deltaY));
      }

      // Horizontal scrolling — mirror deltaX to both editors
      if (deltaX !== 0) {
        const sourceScrollLeft = sourceEditor.getScrollLeft();
        const newScrollLeft = Math.max(0, sourceScrollLeft + deltaX);
        syncingRef.current = true;
        try {
          leftEditor.setScrollLeft(newScrollLeft);
          rightEditor.setScrollLeft(newScrollLeft);
        } finally {
          syncingRef.current = false;
        }
      }
    },
    [alignTo],
  );

  /**
   * Attach `side`'s container: record it and intercept its wheel events. A callback ref rather
   * than an effect because callers mount the containers later than the hook (only once file
   * content has loaded); an effect keyed on stable callbacks would run once, find no container
   * and never attach, leaving wheel scrolling dead until the view remounted.
   */
  const attachContainer = useCallback(
    (side: ScrollSide, container: HTMLDivElement) => {
      const containerRef = side === "left" ? leftContainerRef : rightContainerRef;
      containerRef.current = container;
      const handleWheel = (e: WheelEvent) => {
        e.preventDefault();
        e.stopPropagation();
        scrollBy(side, e.deltaX, e.deltaY);
      };
      container.addEventListener("wheel", handleWheel, { passive: false, capture: true });
      return () => {
        container.removeEventListener("wheel", handleWheel, { capture: true });
        containerRef.current = null;
      };
    },
    [scrollBy],
  );

  const leftContainer = useCallback<RefCallback<HTMLDivElement>>(
    (container) => (container ? attachContainer("left", container) : undefined),
    [attachContainer],
  );

  const rightContainer = useCallback<RefCallback<HTMLDivElement>>(
    (container) => (container ? attachContainer("right", container) : undefined),
    [attachContainer],
  );

  const flushScroll = useCallback(() => {
    const leftScroll = leftEditorRef.current?.getScrollTop() ?? 0;
    const rightScroll = rightEditorRef.current?.getScrollTop() ?? 0;
    notifySubscribers(leftScroll, rightScroll);
  }, [notifySubscribers]);

  const followSelfScroll = useCallback(
    (ed: IStandaloneCodeEditor, source: ScrollSide) => {
      ed.onDidScrollChange((e) => {
        if (syncingRef.current || !ed.hasTextFocus()) return;
        if (e.scrollTopChanged) alignTo(source, e.scrollTop);
        if (e.scrollLeftChanged) {
          const other = source === "left" ? rightEditorRef.current : leftEditorRef.current;
          syncingRef.current = true;
          try {
            other?.setScrollLeft(e.scrollLeft);
          } finally {
            syncingRef.current = false;
          }
        }
      });
    },
    [alignTo],
  );

  const onLeftEditorMount = useCallback(
    (ed: IStandaloneCodeEditor) => {
      leftEditorRef.current = ed;
      followSelfScroll(ed, "left");
    },
    [followSelfScroll],
  );

  const onRightEditorMount = useCallback(
    (ed: IStandaloneCodeEditor) => {
      rightEditorRef.current = ed;
      followSelfScroll(ed, "right");
    },
    [followSelfScroll],
  );

  return {
    onLeftEditorMount,
    onRightEditorMount,
    subscribeToScroll,
    flushScroll,
    scrollBy,
    leftContainer,
    rightContainer,
    leftContainerRef,
    rightContainerRef,
  };
}
