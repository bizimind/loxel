import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { DiffHunk } from "@/api/diff-model";
import type { CollapsibleRegion, LineRange } from "@/components/diff/unchanged-regions";

import { buildCollapsibleRegions, computeHiddenRanges } from "@/components/diff/unchanged-regions";
import { toggleSet } from "@/lib/set-utils";

interface UseCollapsedRegionsResult {
  collapsibleRegions: CollapsibleRegion[];
  expandedSet: Set<number>;
  oldHiddenRanges: LineRange[];
  newHiddenRanges: LineRange[];
  toggleRegion: (index: number) => void;
  expandAll: () => void;
  collapseAll: () => void;
}

export function useCollapsedRegions(
  hunks: DiffHunk[],
  oldLineCount: number,
  newLineCount: number,
): UseCollapsedRegionsResult {
  const [expandedSet, setExpandedSet] = useState<Set<number>>(() => new Set());

  // Reset expanded set when hunks change (e.g., navigating to a different file)
  const prevHunksRef = useRef(hunks);
  useEffect(() => {
    if (prevHunksRef.current !== hunks) {
      prevHunksRef.current = hunks;
      setExpandedSet(new Set());
    }
  }, [hunks]);

  const collapsibleRegions = useMemo(
    () => buildCollapsibleRegions(hunks, oldLineCount, newLineCount),
    [hunks, oldLineCount, newLineCount],
  );

  const { old: oldHiddenRanges, new: newHiddenRanges } = useMemo(
    () => computeHiddenRanges(collapsibleRegions, expandedSet),
    [collapsibleRegions, expandedSet],
  );

  const toggleRegion = useCallback((index: number) => {
    setExpandedSet((prev) => toggleSet(prev, index));
  }, []);

  const expandAll = useCallback(() => {
    setExpandedSet((prev) => {
      const next = new Set(prev);
      for (const r of collapsibleRegions) next.add(r.index);
      return next;
    });
  }, [collapsibleRegions]);

  const collapseAll = useCallback(() => {
    setExpandedSet(new Set());
  }, []);

  return {
    collapsibleRegions,
    expandedSet,
    oldHiddenRanges,
    newHiddenRanges,
    toggleRegion,
    expandAll,
    collapseAll,
  };
}
