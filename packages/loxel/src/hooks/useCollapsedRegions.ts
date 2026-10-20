import { useCallback, useMemo, useState } from "react";

import type { DiffHunk } from "@/api/diff-model";
import type { CollapsibleRegion, LineRange } from "@/components/diff/unchanged-regions";
import {
  buildCollapsibleRegions,
  carryExpandedRegions,
  computeHiddenRanges,
} from "@/components/diff/unchanged-regions";
import { toggleSet } from "@/lib/set-utils";

interface UseCollapsedRegionsResult {
  collapsibleRegions: CollapsibleRegion[];
  expandedSet: Set<number>;
  oldHiddenRanges: LineRange[];
  newHiddenRanges: LineRange[];
  toggleRegion: (index: number) => void;
}

interface UseCollapsedRegionsOptions {
  /**
   * Keep expanded regions expanded when the diff is recomputed (see `carryExpandedRegions`),
   * for views whose content is edited in place. By default every region collapses again when
   * the hunks change, e.g. on moving to another file.
   */
  keepExpandedOnChange?: boolean;
}

interface Expansion {
  hunks: DiffHunk[];
  regions: CollapsibleRegion[];
  expanded: Set<number>;
}

export function useCollapsedRegions(
  hunks: DiffHunk[],
  oldLineCount: number,
  newLineCount: number,
  { keepExpandedOnChange = false }: UseCollapsedRegionsOptions = {},
): UseCollapsedRegionsResult {
  const collapsibleRegions = useMemo(
    () => buildCollapsibleRegions(hunks, oldLineCount, newLineCount),
    [hunks, oldLineCount, newLineCount],
  );

  const [expansion, setExpansion] = useState<Expansion>(() => ({
    hunks,
    regions: collapsibleRegions,
    expanded: new Set(),
  }));

  // Follow the regions during render rather than in an effect, so the hidden ranges never pair
  // new regions with indices meant for old ones, not even for one frame.
  let current = expansion;
  if (expansion.regions !== collapsibleRegions) {
    let expanded = expansion.expanded;
    if (keepExpandedOnChange) {
      expanded = carryExpandedRegions(expansion.regions, expansion.expanded, collapsibleRegions);
    } else if (expansion.hunks !== hunks) {
      expanded = new Set();
    }
    current = { hunks, regions: collapsibleRegions, expanded };
    setExpansion(current);
  }
  const expandedSet = current.expanded;

  const { old: oldHiddenRanges, new: newHiddenRanges } = useMemo(
    () => computeHiddenRanges(collapsibleRegions, expandedSet),
    [collapsibleRegions, expandedSet],
  );

  const toggleRegion = useCallback((index: number) => {
    setExpansion((prev) => ({ ...prev, expanded: toggleSet(prev.expanded, index) }));
  }, []);

  return { collapsibleRegions, expandedSet, oldHiddenRanges, newHiddenRanges, toggleRegion };
}
