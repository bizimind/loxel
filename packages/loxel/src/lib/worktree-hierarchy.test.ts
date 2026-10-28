import { describe, expect, test } from "bun:test";

import {
  buildWorktreeRows,
  childrenByParent,
  descendantsOf,
  moveInOrder,
  resolveParents,
  type HierarchyMember,
} from "./worktree-hierarchy";

function wt(path: string, wtId?: string, parentWtId?: string): HierarchyMember {
  return { path, ...(wtId ? { wtId } : {}), ...(parentWtId ? { parentWtId } : {}) };
}

describe("resolveParents", () => {
  test("nests by parent id and leaves unknown and self references at the top level", () => {
    const parents = resolveParents([
      wt("/a", "a"),
      wt("/b", "b", "a"),
      wt("/c", "c", "missing"),
      wt("/d", "d", "d"),
      wt("/e", undefined, "b"),
    ]);
    expect(Object.fromEntries(parents)).toEqual({
      "/a": null,
      "/b": "/a",
      "/c": null,
      "/d": null,
      "/e": "/b",
    });
  });

  test("puts every worktree on a cycle at the top level, keeping the ones hanging off it", () => {
    const parents = resolveParents([
      wt("/a", "a", "c"),
      wt("/b", "b", "a"),
      wt("/c", "c", "b"),
      wt("/x", "x", "b"),
    ]);
    expect(Object.fromEntries(parents)).toEqual({ "/a": null, "/b": null, "/c": null, "/x": "/b" });
  });
});

describe("descendantsOf", () => {
  test("lists every level, parents before children", () => {
    const children = childrenByParent(
      resolveParents([wt("/a", "a"), wt("/b", "b", "a"), wt("/c", "c", "b"), wt("/d", "d", "a")]),
    );
    expect(descendantsOf("/a", children)).toEqual(["/b", "/d", "/c"]);
    expect(descendantsOf("/c", children)).toEqual([]);
  });
});

describe("buildWorktreeRows", () => {
  const ordered = [wt("/a", "a"), wt("/c", "c", "a"), wt("/z", "z"), wt("/b", "b", "a")];

  test("lists depth-first, siblings in the given order", () => {
    const rows = buildWorktreeRows(ordered, new Set(), new Set());
    expect(rows.map((row) => [row.wt.path, row.depth, row.descendantCount])).toEqual([
      ["/a", 0, 2],
      ["/c", 1, 0],
      ["/b", 1, 0],
      ["/z", 0, 0],
    ]);
  });

  test("leaves out collapsed subtrees and marks hidden ones down the tree", () => {
    expect(
      buildWorktreeRows(ordered, new Set(["/a"]), new Set()).map((row) => row.wt.path),
    ).toEqual(["/a", "/z"]);
    const hidden = buildWorktreeRows(ordered, new Set(), new Set(["/a"]));
    expect(hidden.filter((row) => row.hidden).map((row) => row.wt.path)).toEqual([
      "/a",
      "/c",
      "/b",
    ]);
  });
});

describe("moveInOrder", () => {
  test("places the moved path before or after the target", () => {
    expect(moveInOrder(["/a", "/b", "/c"], "/c", "/a", "before")).toEqual(["/c", "/a", "/b"]);
    expect(moveInOrder(["/a", "/b", "/c"], "/a", "/b", "after")).toEqual(["/b", "/a", "/c"]);
  });

  test("leaves the order alone for an unknown target or a move onto itself", () => {
    expect(moveInOrder(["/a", "/b"], "/a", "/x", "after")).toEqual(["/a", "/b"]);
    expect(moveInOrder(["/a", "/b"], "/a", "/a", "after")).toEqual(["/a", "/b"]);
  });
});
