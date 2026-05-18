import type { RefObject } from "react";
import { useCallback, useEffect, useRef } from "react";

import type { ScrollAlignmentSection } from "@/components/diff/change-regions";
import { translateScrollPosition } from "@/components/diff/change-regions";

/** Delay before syncing follower scroll position after wheel scrolling stops */
const SCROLL_SYNC_DEBOUNCE_MS = 150;

/** Clamp a value between min and max */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

interface UseSyncScrollOptions {
  alignmentSections: ScrollAlignmentSection[];
  lineHeight: number;
}

/** Scroll state that can be read synchronously without triggering re-renders */
export interface ScrollStateRef {
  left: number;
  right: number;
}

interface UseSyncScrollResult {
  leftPanelRef: RefObject<HTMLDivElement | null>;
  rightPanelRef: RefObject<HTMLDivElement | null>;
  leftContentRef: RefObject<HTMLDivElement | null>;
  rightContentRef: RefObject<HTMLDivElement | null>;
  /** Refs for line number containers - receive vertical transforms only */
  leftLineNumbersRef: RefObject<HTMLDivElement | null>;
  rightLineNumbersRef: RefObject<HTMLDivElement | null>;
  /** Ref containing current scroll positions - read this directly, no re-renders */
  scrollStateRef: RefObject<ScrollStateRef>;
  /** Subscribe to scroll updates for direct DOM manipulation */
  subscribeToScroll: (callback: (left: number, right: number) => void) => () => void;
}

/**
 * Hook for smart synchronized scrolling between two panels.
 *
 * Uses CSS transforms on the follower panel to avoid scroll event feedback loops:
 * - Source panel (being scrolled): Uses native scrollTop
 * - Follower panel: Uses CSS transform: translateY() to position content
 *
 * This enables lag-free scrolling with proper alignment handling:
 * - Aligned sections: Both panels scroll together 1:1
 * - Insertions (right-only): Right scrolls independently
 * - Deletions (left-only): Left scrolls independently
 */
export function useSyncScroll(options: UseSyncScrollOptions): UseSyncScrollResult {
  const leftPanelRef = useRef<HTMLDivElement>(null);
  const rightPanelRef = useRef<HTMLDivElement>(null);
  const leftContentRef = useRef<HTMLDivElement>(null);
  const rightContentRef = useRef<HTMLDivElement>(null);
  const leftLineNumbersRef = useRef<HTMLDivElement>(null);
  const rightLineNumbersRef = useRef<HTMLDivElement>(null);

  // Store vertical scroll state in ref to avoid re-renders
  const scrollStateRef = useRef<ScrollStateRef>({ left: 0, right: 0 });

  // Store horizontal scroll state (delta-based sync, not alignment-based)
  const horizontalStateRef = useRef<{ left: number; right: number }>({ left: 0, right: 0 });

  // Track combined transform offsets for both axes during wheel scrolling
  const transformOffsetRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  // Subscribers for scroll updates (for direct DOM manipulation)
  const subscribersRef = useRef<Set<(left: number, right: number) => void>>(new Set());

  // Subscribe to scroll updates
  const subscribeToScroll = useCallback((callback: (left: number, right: number) => void) => {
    subscribersRef.current.add(callback);
    // Call immediately with current state
    callback(scrollStateRef.current.left, scrollStateRef.current.right);
    // Return unsubscribe function
    return () => {
      subscribersRef.current.delete(callback);
    };
  }, []);

  // Notify all subscribers of scroll update
  const notifySubscribers = useCallback((left: number, right: number) => {
    scrollStateRef.current = { left, right };
    for (const callback of subscribersRef.current) {
      callback(left, right);
    }
  }, []);

  // Track active scrolling source to prevent feedback
  const activeSourceRef = useRef<"left" | "right" | null>(null);

  // Track pending sync for follower scrollTop (for scrollbar position)
  const syncTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear transform and sync scroll position on idle.
  // Note: The order of operations in the timeout is important:
  // 1. Clear transform first (removes visual offset)
  // 2. Set scrollTop/scrollLeft (may trigger scroll event, but activeSourceRef is still set)
  // 3. Clear activeSourceRef last (allows scroll handler to process subsequent events)
  const scheduleScrollSync = useCallback(
    (
      followerPanel: HTMLDivElement,
      followerContent: HTMLDivElement,
      followerLineNumbers: HTMLDivElement | null,
      targetScrollTop: number,
      targetScrollLeft: number,
    ) => {
      if (syncTimeoutRef.current) {
        clearTimeout(syncTimeoutRef.current);
      }
      syncTimeoutRef.current = setTimeout(() => {
        // Clear combined transform on content
        followerContent.style.transform = "";
        transformOffsetRef.current = { x: 0, y: 0 };

        // Clamp to valid scroll ranges in case layout changed
        const maxScrollY = followerPanel.scrollHeight - followerPanel.clientHeight;
        const maxScrollX = followerPanel.scrollWidth - followerPanel.clientWidth;
        const clampedScrollTop = clamp(targetScrollTop, 0, maxScrollY);
        followerPanel.scrollTop = clampedScrollTop;
        followerPanel.scrollLeft = clamp(targetScrollLeft, 0, maxScrollX);

        // Line numbers don't scroll natively - keep their transform at target position
        if (followerLineNumbers) {
          followerLineNumbers.style.transform = `translateY(${-clampedScrollTop}px)`;
        }

        activeSourceRef.current = null;
      }, SCROLL_SYNC_DEBOUNCE_MS);
    },
    [],
  );

  // Handle wheel events with CSS transform approach (both vertical and horizontal)
  const handleWheel = useCallback(
    (e: WheelEvent, source: "left" | "right") => {
      e.preventDefault();

      const leftPanel = leftPanelRef.current;
      const rightPanel = rightPanelRef.current;
      const leftContent = leftContentRef.current;
      const rightContent = rightContentRef.current;
      const leftLineNumbers = leftLineNumbersRef.current;
      const rightLineNumbers = rightLineNumbersRef.current;

      if (!leftPanel || !rightPanel || !leftContent || !rightContent) return;

      const sourcePanel = source === "left" ? leftPanel : rightPanel;
      const followerPanel = source === "left" ? rightPanel : leftPanel;
      const followerContent = source === "left" ? rightContent : leftContent;
      const sourceLineNumbers = source === "left" ? leftLineNumbers : rightLineNumbers;
      const followerLineNumbers = source === "left" ? rightLineNumbers : leftLineNumbers;
      const followerSide = source === "left" ? "right" : "left";

      // Guard against zero-size panels (during initial render or collapsed state)
      if (sourcePanel.clientHeight === 0) return;

      let verticalOffset = transformOffsetRef.current.y;
      let horizontalOffset = transformOffsetRef.current.x;
      let followerTargetY = followerPanel.scrollTop + verticalOffset;
      let followerTargetX = followerPanel.scrollLeft + horizontalOffset;
      let sourceScrollY = sourcePanel.scrollTop;

      // === VERTICAL SCROLLING (alignment-based) ===
      if (e.deltaY !== 0) {
        // Calculate new source scroll position
        const maxScrollY = sourcePanel.scrollHeight - sourcePanel.clientHeight;
        const newSourceScrollY = clamp(sourcePanel.scrollTop + e.deltaY, 0, maxScrollY);
        sourceScrollY = newSourceScrollY;

        // Translate to get both positions based on alignment (using 50% viewport midpoint rule)
        const viewportHeight = sourcePanel.clientHeight;
        const { leftScroll, rightScroll } = translateScrollPosition(
          source,
          newSourceScrollY,
          options.alignmentSections,
          options.lineHeight,
          viewportHeight,
        );

        // Apply native scroll to source panel
        sourcePanel.scrollTop = newSourceScrollY;

        // Calculate vertical transform offset for follower
        followerTargetY = source === "left" ? rightScroll : leftScroll;
        verticalOffset = followerTargetY - followerPanel.scrollTop;

        // Notify subscribers for gutter update (no React re-render!)
        notifySubscribers(leftScroll, rightScroll);
      }

      // === HORIZONTAL SCROLLING (delta-based) ===
      if (e.deltaX !== 0) {
        // Apply delta to source
        const sourceMaxX = sourcePanel.scrollWidth - sourcePanel.clientWidth;
        const newSourceScrollX = clamp(sourcePanel.scrollLeft + e.deltaX, 0, sourceMaxX);
        sourcePanel.scrollLeft = newSourceScrollX;

        // Apply same delta to follower (bounded by its own max scroll)
        const followerMaxX = followerPanel.scrollWidth - followerPanel.clientWidth;
        const currentFollowerX = followerPanel.scrollLeft + horizontalOffset;
        followerTargetX = clamp(currentFollowerX + e.deltaX, 0, followerMaxX);

        // Calculate horizontal transform offset
        horizontalOffset = followerTargetX - followerPanel.scrollLeft;

        // Update horizontal state
        horizontalStateRef.current = {
          ...horizontalStateRef.current,
          [source]: newSourceScrollX,
          [followerSide]: followerTargetX,
        };
      }

      // === TRANSFORMS ===
      transformOffsetRef.current = { x: horizontalOffset, y: verticalOffset };

      // Follower content: both horizontal and vertical transform
      followerContent.style.transform = `translate(${-horizontalOffset}px, ${-verticalOffset}px)`;

      // Line numbers: vertical transform only (they don't scroll horizontally)
      // Source line numbers need transform because source uses native scroll
      if (sourceLineNumbers) {
        sourceLineNumbers.style.transform = `translateY(${-sourceScrollY}px)`;
      }
      // Follower line numbers need the vertical offset
      if (followerLineNumbers) {
        followerLineNumbers.style.transform = `translateY(${-followerTargetY}px)`;
      }

      // Mark active source to prevent scroll handler interference
      activeSourceRef.current = source;

      // Schedule sync of follower scroll position on idle
      scheduleScrollSync(
        followerPanel,
        followerContent,
        followerLineNumbers,
        followerTargetY,
        followerTargetX,
      );
    },
    [options.alignmentSections, options.lineHeight, scheduleScrollSync, notifySubscribers],
  );

  // Handle scrollbar drag (native scroll events) - both vertical and horizontal
  const handleScroll = useCallback(
    (e: Event, source: "left" | "right") => {
      // Skip if we're handling wheel events
      if (activeSourceRef.current !== null) return;

      // Use currentTarget (element listener is attached to) for type safety
      const target = e.currentTarget as HTMLDivElement;
      const scrollTop = target.scrollTop;
      const scrollLeft = target.scrollLeft;

      const leftPanel = leftPanelRef.current;
      const rightPanel = rightPanelRef.current;
      const leftContent = leftContentRef.current;
      const rightContent = rightContentRef.current;
      const leftLineNumbers = leftLineNumbersRef.current;
      const rightLineNumbers = rightLineNumbersRef.current;

      if (!leftPanel || !rightPanel || !leftContent || !rightContent) return;

      const followerPanel = source === "left" ? rightPanel : leftPanel;
      const followerContent = source === "left" ? rightContent : leftContent;
      const sourceLineNumbers = source === "left" ? leftLineNumbers : rightLineNumbers;
      const followerLineNumbers = source === "left" ? rightLineNumbers : leftLineNumbers;
      const followerSide = source === "left" ? "right" : "left";

      // Detect which axis changed
      const prevScrollLeft = horizontalStateRef.current[source];
      const isHorizontalScroll = scrollLeft !== prevScrollLeft;

      // Clear any transform for scrollbar drag
      followerContent.style.transform = "";
      if (followerLineNumbers) {
        followerLineNumbers.style.transform = "";
      }
      transformOffsetRef.current = { x: 0, y: 0 };

      // === VERTICAL SCROLLING (alignment-based) ===
      // Translate position based on alignment (using 50% viewport midpoint rule)
      const sourcePanel = source === "left" ? leftPanel : rightPanel;
      const viewportHeight = sourcePanel.clientHeight;
      const { leftScroll, rightScroll } = translateScrollPosition(
        source,
        scrollTop,
        options.alignmentSections,
        options.lineHeight,
        viewportHeight,
      );

      // For scrollbar drag, we can directly set follower scrollTop
      const followerTargetY = source === "left" ? rightScroll : leftScroll;
      const maxScrollY = followerPanel.scrollHeight - followerPanel.clientHeight;
      followerPanel.scrollTop = clamp(followerTargetY, 0, maxScrollY);

      // Line numbers need transform since they don't scroll natively
      if (sourceLineNumbers) {
        sourceLineNumbers.style.transform = `translateY(${-scrollTop}px)`;
      }
      if (followerLineNumbers) {
        followerLineNumbers.style.transform = `translateY(${-followerTargetY}px)`;
      }

      // === HORIZONTAL SCROLLING (delta-based) ===
      if (isHorizontalScroll) {
        // Calculate delta from previous position
        const deltaX = scrollLeft - prevScrollLeft;

        // Apply same delta to follower (bounded)
        const followerMaxX = followerPanel.scrollWidth - followerPanel.clientWidth;
        const newFollowerX = clamp(followerPanel.scrollLeft + deltaX, 0, followerMaxX);
        followerPanel.scrollLeft = newFollowerX;

        // Update horizontal state
        horizontalStateRef.current = {
          ...horizontalStateRef.current,
          [source]: scrollLeft,
          [followerSide]: newFollowerX,
        };
      }

      // Notify subscribers for gutter update (no React re-render!)
      notifySubscribers(leftScroll, rightScroll);
    },
    [options.alignmentSections, options.lineHeight, notifySubscribers],
  );

  // Set up event listeners
  useEffect(() => {
    const leftPanel = leftPanelRef.current;
    const rightPanel = rightPanelRef.current;

    if (!leftPanel || !rightPanel) return;

    const leftWheelHandler = (e: WheelEvent) => handleWheel(e, "left");
    const rightWheelHandler = (e: WheelEvent) => handleWheel(e, "right");
    const leftScrollHandler = (e: Event) => handleScroll(e, "left");
    const rightScrollHandler = (e: Event) => handleScroll(e, "right");

    // Wheel events with passive: false to allow preventDefault
    leftPanel.addEventListener("wheel", leftWheelHandler, { passive: false });
    rightPanel.addEventListener("wheel", rightWheelHandler, { passive: false });

    // Scroll events for scrollbar drag
    leftPanel.addEventListener("scroll", leftScrollHandler);
    rightPanel.addEventListener("scroll", rightScrollHandler);

    return () => {
      leftPanel.removeEventListener("wheel", leftWheelHandler);
      rightPanel.removeEventListener("wheel", rightWheelHandler);
      leftPanel.removeEventListener("scroll", leftScrollHandler);
      rightPanel.removeEventListener("scroll", rightScrollHandler);
      if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current);
    };
  }, [handleWheel, handleScroll]);

  return {
    leftPanelRef,
    rightPanelRef,
    leftContentRef,
    rightContentRef,
    leftLineNumbersRef,
    rightLineNumbersRef,
    scrollStateRef,
    subscribeToScroll,
  };
}
