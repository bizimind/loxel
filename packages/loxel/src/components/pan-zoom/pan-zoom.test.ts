import { describe, expect, test } from "bun:test";

import {
  fitWithin,
  IDENTITY_VIEW,
  viewTransform,
  wheelZoomFactor,
  ZOOM_MAX,
  zoomAt,
} from "./pan-zoom";

describe("zoomAt", () => {
  test("keeps the content under the anchor point in place", () => {
    const view = zoomAt({ x: 10, y: -20, scale: 2 }, 1.5, { x: 100, y: 50 });
    expect(view.scale).toBe(3);
    // The content point under (100, 50) before the zoom: (anchor - translate) / scale.
    const before = { x: (100 - 10) / 2, y: (50 + 20) / 2 };
    expect(before.x * view.scale + view.x).toBeCloseTo(100);
    expect(before.y * view.scale + view.y).toBeCloseTo(50);
  });

  test("clamps the scale and anchors the clamped zoom", () => {
    expect(zoomAt(IDENTITY_VIEW, 1000, { x: 0, y: 0 }).scale).toBe(ZOOM_MAX);
    expect(zoomAt(IDENTITY_VIEW, 0.1, { x: 40, y: 0 }, { min: 0.5, max: 2 })).toEqual({
      scale: 0.5,
      x: 20,
      y: 0,
    });
  });
});

test("wheelZoomFactor zooms in on negative deltas and doubles per 100", () => {
  expect(wheelZoomFactor(-100)).toBe(2);
  expect(wheelZoomFactor(100)).toBe(0.5);
  expect(wheelZoomFactor(0)).toBe(1);
});

test("fitWithin shrinks to fit but never grows", () => {
  expect(fitWithin({ width: 2000, height: 500 }, { width: 1000, height: 1000 })).toEqual({
    width: 1000,
    height: 250,
  });
  expect(fitWithin({ width: 200, height: 100 }, { width: 1000, height: 1000 })).toEqual({
    width: 200,
    height: 100,
  });
});

test("viewTransform", () => {
  expect(viewTransform({ x: 1, y: -2, scale: 3 })).toBe("translate(1px, -2px) scale(3)");
});
