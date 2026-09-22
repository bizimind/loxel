import { describe, expect, it } from "bun:test";

import { wheelSideForPointer } from "./DiffGutter";

function boundaryAt(left: number): Element {
  const el = document.createElement("div");
  el.getBoundingClientRect = () => new DOMRect(left, 0, 0, 800);
  return el;
}

describe("wheelSideForPointer", () => {
  it("resolves pointers left of the wrapper's left edge to the left panel", () => {
    const boundary = boundaryAt(500);
    expect(wheelSideForPointer(100, boundary)).toBe("left");
    expect(wheelSideForPointer(499.9, boundary)).toBe("left");
  });

  it("resolves pointers at or right of the wrapper's left edge to the right panel", () => {
    const boundary = boundaryAt(500);
    expect(wheelSideForPointer(500, boundary)).toBe("right");
    expect(wheelSideForPointer(900, boundary)).toBe("right");
  });
});
