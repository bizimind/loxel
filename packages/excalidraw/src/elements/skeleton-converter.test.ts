import { expect, test } from "bun:test";

import { withDom } from "../dom-shim.ts";
import { buildArrowSkeleton, buildContainerSkeleton } from "./element-factory.ts";
import { skeletonsToElements } from "./skeleton-converter.ts";

test.each([
  [undefined, "arrow"],
  ["none", null],
  ["triangle", "triangle"],
])("draw arrow --end-head %p gives end arrowhead %p", (endHead, expected) => {
  expect(buildArrowSkeleton({ endHead }).endArrowhead).toBe(expected);
});

test("keeps a skeleton's null arrowheads and defaults only missing ones", async () => {
  const [none, missing] = await withDom(() =>
    skeletonsToElements([
      {
        type: "arrow",
        points: [
          [0, 0],
          [100, 0],
        ],
        startArrowhead: null,
        endArrowhead: null,
      },
      {
        type: "arrow",
        points: [
          [0, 0],
          [100, 0],
        ],
      },
    ]),
  );
  expect(none?.endArrowhead).toBeNull();
  expect(missing?.endArrowhead).toBe("arrow");
});

test("sizes linear elements to their points", async () => {
  const [line] = await withDom(() =>
    skeletonsToElements([
      {
        type: "line",
        points: [
          [0, 0],
          [40, -30],
          [120, 10],
        ],
      },
    ]),
  );
  expect(line?.width).toBe(120);
  expect(line?.height).toBe(40);
});

test("sizes a labeled container given no width or height to its label", async () => {
  const [box, text] = await withDom(() =>
    skeletonsToElements([buildContainerSkeleton("rectangle", { text: "My Box" })]),
  );
  expect(box!.width).toBeGreaterThan(text!.width);
  expect(box!.height).toBeGreaterThan(text!.height);
  // The label is centered in the box.
  expect(text!.x + text!.width / 2).toBeCloseTo(box!.x + box!.width / 2);
});
