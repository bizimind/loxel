import type { DiffHunk } from "@/api/diff-model";

export interface ChangeRegion {
  startLine: number;
  endLine: number;
  type: "add" | "delete" | "modify";
}

export interface ChangePair {
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
  type: "add" | "delete" | "modify";
}

export interface ChangeRegions {
  old: ChangeRegion[];
  new: ChangeRegion[];
  pairs: ChangePair[];
}

/**
 * Build change regions from diff hunks.
 * This maps hunk-based diffs to line-based change regions for rendering.
 */
export function buildChangeRegions(hunks: DiffHunk[]): ChangeRegions {
  const oldRegions: ChangeRegion[] = [];
  const newRegions: ChangeRegion[] = [];
  const pairs: ChangePair[] = [];

  for (const hunk of hunks) {
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;

    // Track consecutive deletes and adds to pair them as modifications
    let deleteStart: number | null = null;
    let deleteEnd: number | null = null;
    let addStart: number | null = null;
    let addEnd: number | null = null;

    const flushPair = () => {
      if (deleteStart !== null && addStart !== null) {
        // Both deletes and adds - this is a modification (blue on both sides)
        oldRegions.push({ startLine: deleteStart, endLine: deleteEnd!, type: "modify" });
        newRegions.push({ startLine: addStart, endLine: addEnd!, type: "modify" });
        pairs.push({
          oldStart: deleteStart,
          oldEnd: deleteEnd!,
          newStart: addStart,
          newEnd: addEnd!,
          type: "modify",
        });
      } else if (deleteStart !== null) {
        // Only deletes
        oldRegions.push({ startLine: deleteStart, endLine: deleteEnd!, type: "delete" });
        pairs.push({
          oldStart: deleteStart,
          oldEnd: deleteEnd!,
          newStart: newLine,
          newEnd: newLine,
          type: "delete",
        });
      } else if (addStart !== null) {
        // Only adds
        newRegions.push({ startLine: addStart, endLine: addEnd!, type: "add" });
        pairs.push({
          oldStart: oldLine,
          oldEnd: oldLine,
          newStart: addStart,
          newEnd: addEnd!,
          type: "add",
        });
      }
      deleteStart = deleteEnd = addStart = addEnd = null;
    };

    for (const line of hunk.lines) {
      if (line.type === "delete") {
        if (deleteStart === null) {
          deleteStart = oldLine;
        }
        deleteEnd = oldLine;
        oldLine++;
      } else if (line.type === "add") {
        if (addStart === null) {
          addStart = newLine;
        }
        addEnd = newLine;
        newLine++;
      } else {
        // Context line - flush current pair
        flushPair();
        oldLine++;
        newLine++;
      }
    }

    // Flush any remaining pair at end of hunk
    flushPair();
  }

  return { old: oldRegions, new: newRegions, pairs };
}

/**
 * Build a map of line number -> change type for O(1) lookup during rendering.
 */
export type ChangeType = "add" | "delete" | "modify";

export function buildLineChangeMap(regions: ChangeRegion[]): Map<number, ChangeType> {
  const map = new Map<number, ChangeType>();
  for (const region of regions) {
    for (let i = region.startLine; i <= region.endLine; i++) {
      map.set(i, region.type);
    }
  }
  return map;
}

/**
 * Scroll alignment section - tracks how lines on left and right panels align.
 * Used for smart synchronized scrolling.
 */
export interface ScrollAlignmentSection {
  /** Type of alignment:
   * - "aligned": Both sides have same number of lines, scroll together 1:1
   * - "left-only": Left has lines, right has none (deletion) - left scrolls independently
   * - "right-only": Right has lines, left has none (insertion) - right scrolls independently
   */
  type: "aligned" | "left-only" | "right-only";
  /** Starting line on the left side (1-indexed) */
  leftStartLine: number;
  /** Ending line on the left side (1-indexed, inclusive) */
  leftEndLine: number;
  /** Starting line on the right side (1-indexed) */
  rightStartLine: number;
  /** Ending line on the right side (1-indexed, inclusive) */
  rightEndLine: number;
}

/**
 * Build scroll alignment sections from diff hunks.
 * This creates a map of how lines on left and right panels correspond
 * to enable smart synchronized scrolling.
 *
 * The algorithm:
 * 1. Start from the beginning of both files
 * 2. For each hunk, we know where changes start in both old and new files
 * 3. Lines before the hunk are aligned (context)
 * 4. Within a hunk: deletions are left-only, additions are right-only,
 *    modifications pair up proportionally, context lines are aligned
 * 5. After processing all hunks, remaining lines are aligned
 */
export function buildScrollAlignment(
  hunks: DiffHunk[],
  oldLineCount: number,
  newLineCount: number,
): ScrollAlignmentSection[] {
  const sections: ScrollAlignmentSection[] = [];
  let oldLine = 1;
  let newLine = 1;

  const addSection = (
    type: "aligned" | "left-only" | "right-only",
    leftStart: number,
    leftEnd: number,
    rightStart: number,
    rightEnd: number,
  ) => {
    // Only add sections with actual lines
    if (leftEnd >= leftStart || rightEnd >= rightStart) {
      sections.push({
        type,
        leftStartLine: leftStart,
        leftEndLine: leftEnd,
        rightStartLine: rightStart,
        rightEndLine: rightEnd,
      });
    }
  };

  for (const hunk of hunks) {
    // Add aligned section for lines before this hunk
    if (hunk.oldStart > oldLine || hunk.newStart > newLine) {
      const alignedOldLines = hunk.oldStart - oldLine;
      const alignedNewLines = hunk.newStart - newLine;

      // These should be equal for proper alignment, but handle mismatches
      if (alignedOldLines > 0 && alignedNewLines > 0) {
        addSection("aligned", oldLine, hunk.oldStart - 1, newLine, hunk.newStart - 1);
      }
      oldLine = hunk.oldStart;
      newLine = hunk.newStart;
    }

    // Process hunk lines
    let deleteStart: number | null = null;
    let deleteCount = 0;
    let addStart: number | null = null;
    let addCount = 0;

    const flushChanges = () => {
      if (deleteCount > 0 && addCount > 0) {
        // Modification: both sides change. For scrolling, we pair them up.
        // The side with more lines scrolls independently for the extra lines.
        const minCount = Math.min(deleteCount, addCount);
        const extraDeletes = deleteCount - minCount;
        const extraAdds = addCount - minCount;

        // First, the aligned portion (modifications that pair up)
        if (minCount > 0) {
          addSection(
            "aligned",
            deleteStart!,
            deleteStart! + minCount - 1,
            addStart!,
            addStart! + minCount - 1,
          );
        }

        // Extra deletions (left-only)
        if (extraDeletes > 0) {
          addSection(
            "left-only",
            deleteStart! + minCount,
            deleteStart! + deleteCount - 1,
            addStart! + addCount, // Point to the line AFTER the adds
            addStart! + addCount - 1, // Empty range (start > end conceptually, but we track position)
          );
        }

        // Extra additions (right-only)
        if (extraAdds > 0) {
          addSection(
            "right-only",
            deleteStart! + deleteCount, // Point to the line AFTER the deletes
            deleteStart! + deleteCount - 1, // Empty range
            addStart! + minCount,
            addStart! + addCount - 1,
          );
        }

        oldLine = deleteStart! + deleteCount;
        newLine = addStart! + addCount;
      } else if (deleteCount > 0) {
        // Pure deletion (left-only)
        addSection("left-only", deleteStart!, deleteStart! + deleteCount - 1, newLine, newLine - 1);
        oldLine = deleteStart! + deleteCount;
      } else if (addCount > 0) {
        // Pure addition (right-only)
        addSection("right-only", oldLine, oldLine - 1, addStart!, addStart! + addCount - 1);
        newLine = addStart! + addCount;
      }

      deleteStart = null;
      deleteCount = 0;
      addStart = null;
      addCount = 0;
    };

    // Track consecutive context lines to coalesce into single aligned sections
    let contextStart: { old: number; new: number } | null = null;

    const flushContext = () => {
      if (contextStart !== null) {
        addSection("aligned", contextStart.old, oldLine - 1, contextStart.new, newLine - 1);
        contextStart = null;
      }
    };

    for (const line of hunk.lines) {
      if (line.type === "delete") {
        flushContext();
        if (deleteStart === null) {
          deleteStart = oldLine;
        }
        deleteCount++;
        oldLine++;
      } else if (line.type === "add") {
        flushContext();
        if (addStart === null) {
          addStart = newLine;
        }
        addCount++;
        newLine++;
      } else {
        // Context line - flush pending changes first, then track context
        flushChanges();
        if (contextStart === null) {
          contextStart = { old: oldLine, new: newLine };
        }
        oldLine++;
        newLine++;
      }
    }

    // Flush remaining context and changes at end of hunk
    flushContext();
    flushChanges();
  }

  // Add aligned section for remaining lines after all hunks
  if (oldLine <= oldLineCount || newLine <= newLineCount) {
    addSection("aligned", oldLine, oldLineCount, newLine, newLineCount);
  }

  return sections;
}

/**
 * Given a scroll position on one side, compute the corresponding scroll
 * position for both sides based on alignment sections.
 *
 * Key behaviors:
 * 1. SOURCE panel (being scrolled) ALWAYS scrolls exactly to scrollTop - never pauses or jumps
 * 2. FOLLOWER panel pauses or catches up to maintain alignment
 * 3. Uses "50% viewport midpoint rule": Switch from previous to next context alignment
 *    when a change section's midpoint crosses the viewport center
 * 4. Symmetrical: scrolling left behaves same as scrolling right with sides swapped
 *
 * The pause/catch-up behavior:
 * - Before midpoint crosses center: follower follows source 1:1
 * - After midpoint crosses center: follower pauses at its current position
 * - When source exits the change section: follower jumps to align with next context
 *
 * @param fromSide - Which side is being scrolled (source)
 * @param scrollTop - Current scroll position in pixels
 * @param sections - Alignment sections from buildScrollAlignment()
 * @param lineHeight - Height of each line in pixels
 * @param viewportHeight - Height of the visible viewport in pixels
 */
export function translateScrollPosition(
  fromSide: "left" | "right",
  scrollTop: number,
  sections: ScrollAlignmentSection[],
  lineHeight: number,
  viewportHeight: number = 0,
): { leftScroll: number; rightScroll: number } {
  if (sections.length === 0 || viewportHeight === 0) {
    return { leftScroll: scrollTop, rightScroll: scrollTop };
  }

  const isSourceLeft = fromSide === "left";
  const viewportCenter = viewportHeight / 2;

  // Build list of changes with their properties
  interface ChangeInfo {
    contentMidpoint: number; // In the coordinate system of the side with content
    contentOnSource: boolean; // Is the content on the source side?
    offset: number; // Offset to apply (positive = follower has more, negative = follower has less)
  }

  const changes: ChangeInfo[] = [];
  let leftPos = 0;
  let rightPos = 0;

  for (const section of sections) {
    const leftLines = Math.max(0, section.leftEndLine - section.leftStartLine + 1);
    const rightLines = Math.max(0, section.rightEndLine - section.rightStartLine + 1);
    const leftPx = leftLines * lineHeight;
    const rightPx = rightLines * lineHeight;

    if (section.type !== "aligned") {
      // Calculate offset (follower pixels - source pixels)
      const offset = isSourceLeft ? rightPx - leftPx : leftPx - rightPx;

      // Determine content location and midpoint
      let contentMidpoint: number;
      let contentOnSource: boolean;

      if (section.type === "left-only") {
        contentMidpoint = leftPos + leftPx / 2;
        contentOnSource = isSourceLeft;
      } else {
        contentMidpoint = rightPos + rightPx / 2;
        contentOnSource = !isSourceLeft;
      }

      changes.push({ contentMidpoint, contentOnSource, offset });
    }

    leftPos += leftPx;
    rightPos += rightPx;
  }

  // Calculate total offset by processing changes in order.
  // Each change transitions when its content midpoint crosses viewport center.
  // The transition point depends on accumulated offset from prior changes.
  //
  // PAUSE OPTIMIZATION: When offset is negative (source has more content than follower),
  // instead of jumping instantly, we pause the follower while source scrolls through
  // its extra content. This creates a smoother visual experience.
  let totalOffset = 0;

  for (const change of changes) {
    // Calculate the transition point in source scroll coordinates
    let transitionScroll: number;

    if (change.contentOnSource) {
      // Content is on source side - use source coordinates directly
      // Midpoint crosses center when: contentMidpoint - scrollTop = viewportCenter
      // scrollTop = contentMidpoint - viewportCenter
      transitionScroll = change.contentMidpoint - viewportCenter;
    } else {
      // Content is on follower side
      // Before this change, followerScroll = sourceScroll + totalOffset
      // Midpoint crosses center when: contentMidpoint - followerScroll = viewportCenter
      // contentMidpoint - (sourceScroll + totalOffset) = viewportCenter
      // sourceScroll = contentMidpoint - viewportCenter - totalOffset
      transitionScroll = change.contentMidpoint - viewportCenter - totalOffset;
    }

    if (change.offset < 0) {
      // NEGATIVE offset = source has more content = CAN PAUSE
      // Instead of jumping, pause the follower while source scrolls through extra content
      const pauseStart = transitionScroll;
      const pauseEnd = transitionScroll + Math.abs(change.offset);

      if (scrollTop >= pauseStart && scrollTop < pauseEnd) {
        // IN PAUSE ZONE: follower stays at pause start position
        // This creates smooth scrolling instead of an instant jump
        const followerScroll = Math.max(0, pauseStart + totalOffset);
        return {
          leftScroll: isSourceLeft ? scrollTop : followerScroll,
          rightScroll: isSourceLeft ? followerScroll : scrollTop,
        };
      }

      if (scrollTop >= pauseEnd) {
        // PAST PAUSE ZONE: offset is now "absorbed"
        totalOffset += change.offset;
      }
    } else if (scrollTop >= transitionScroll) {
      // POSITIVE offset = follower has more content = MUST JUMP
      // Cannot pause backwards, so we apply the offset instantly
      totalOffset += change.offset;
    }
  }

  const sourceScroll = scrollTop;
  const followerScroll = Math.max(0, scrollTop + totalOffset);

  return {
    leftScroll: isSourceLeft ? sourceScroll : followerScroll,
    rightScroll: isSourceLeft ? followerScroll : sourceScroll,
  };
}
