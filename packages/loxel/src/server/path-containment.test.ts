import { describe, expect, test } from "bun:test";

import { isInside, pathOutsideWorktree } from "./path-containment";

describe("isInside", () => {
  test.each([
    ["/wt", "/wt"],
    ["/wt/a/b", "/wt"],
    ["/wt/..a", "/wt"],
  ])("%p is inside %p", (child, parent) => {
    expect(isInside(child, parent)).toBe(true);
  });

  test.each([
    ["/wt-other", "/wt"],
    ["/", "/wt"],
    ["/wt/../x", "/wt"],
  ])("%p is not inside %p", (child, parent) => {
    expect(isInside(child, parent)).toBe(false);
  });
});

describe("pathOutsideWorktree", () => {
  test("drops the worktree's own directories and keeps the rest in order", () => {
    expect(pathOutsideWorktree("/wt/bin:/usr/bin:/wt:/wt-other/bin:bin:/opt/bin", "/wt")).toBe(
      "/usr/bin:/wt-other/bin:/opt/bin",
    );
  });
});
