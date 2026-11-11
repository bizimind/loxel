import { afterEach, describe, expect, test } from "bun:test";

import { DockviewComponent } from "dockview-react";

import { detectPanelSide, findGridLeaf } from "./dockview-utils";

let dockview: DockviewComponent | undefined;

afterEach(() => {
  dockview?.dispose();
  dockview = undefined;
});

/** A grid with a `content` panel and a `sidebar` panel docked to `side` of it. */
function gridWithSidebar(side: "left" | "right") {
  dockview = new DockviewComponent(document.createElement("div"), {
    createComponent: () => ({ element: document.createElement("div"), init() {} }),
  });
  dockview.layout(1000, 500);
  dockview.api.addPanel({ id: "content", component: "default" });
  dockview.api.addPanel({
    id: "sidebar",
    component: "default",
    position: { referencePanel: "content", direction: side },
    initialWidth: 200,
  });
  return dockview.api.toJSON().grid;
}

describe("detectPanelSide", () => {
  // happy-dom measures every element at 0×0, like a grid that is hidden or still opening.
  test.each(["left", "right"] as const)("finds a sidebar docked %s", (side) => {
    expect(detectPanelSide(gridWithSidebar(side), "sidebar", "content")).toBe(side);
  });
});

describe("findGridLeaf", () => {
  test("gives the position and size of the group holding a panel", () => {
    const grid = gridWithSidebar("right");

    expect(findGridLeaf(grid, "sidebar")).toEqual({ index: 1, size: 200 });
    expect(findGridLeaf(grid, "missing")).toBeUndefined();
  });
});
