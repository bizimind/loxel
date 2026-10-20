import { describe, expect, it } from "bun:test";

import { computeFileDiff } from "./compute-file-diff";
import { buildCollapsibleRegions, carryExpandedRegions } from "./unchanged-regions";

const numbered = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`);

function regionsFor(oldLines: string[], newLines: string[]) {
  const { hunks } = computeFileDiff(oldLines, newLines);
  return buildCollapsibleRegions(hunks, oldLines.length, newLines.length);
}

describe("carryExpandedRegions", () => {
  // Changed lines 30 and 170 of 200: three collapsible gaps.
  const base = numbered(200);
  const edited = base.map((l, i) => (i === 29 || i === 169 ? `${l} changed` : l));

  it("keeps an expanded region expanded when lines are inserted above it on one side", () => {
    const before = regionsFor(base, edited);
    expect(before).toHaveLength(3);

    // Insert five lines near the top of the new side: every later region shifts there only.
    const shifted = [
      ...edited.slice(0, 2),
      ...numbered(5).map((l) => `new ${l}`),
      ...edited.slice(2),
    ];
    const after = regionsFor(base, shifted);

    const carried = carryExpandedRegions(before, new Set([2]), after);
    const last = after.at(-1)!;
    expect(carried).toEqual(new Set([last.index]));
  });

  it("collapses nothing that was expanded and expands nothing that was collapsed", () => {
    const regions = regionsFor(base, edited);
    expect(carryExpandedRegions(regions, new Set(), regions)).toEqual(new Set());
    expect(carryExpandedRegions(regions, new Set([0, 1, 2]), regions)).toEqual(new Set([0, 1, 2]));
  });

  it("follows a region that a new change splits, and drops one with nothing to overlap", () => {
    const before = regionsFor(base, edited);
    // Changing line 100 splits the middle gap into two regions that each still overlap it.
    const split = regionsFor(
      base,
      edited.map((l, i) => (i === 99 ? "mid" : l)),
    );
    expect(carryExpandedRegions(before, new Set([1]), split).size).toBe(2);

    // Making the files identical leaves one whole-file region, overlapping nothing expanded.
    const none = regionsFor(base, base);
    expect(carryExpandedRegions(before, new Set([0]), none)).toEqual(new Set([0]));
    expect(carryExpandedRegions([], new Set([0]), none)).toEqual(new Set());
  });
});
